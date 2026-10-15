import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { formatDate } from '../../shared/clock.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import type { EventType } from '../../shared/events.js';
import { generateId, randomDigits } from '../../shared/ids.js';
import { compact } from '../../shared/schemas.js';
import type { Repository } from '../../shared/store/repository.js';
import { detectBrand, normalizeBrand } from '../cards/card-number.js';
import { cardView, type Card } from '../cards/card.js';
import { CardsService, type NewCard } from '../cards/service.js';
import { CustomersService } from '../customers/service.js';
import { orderSummaryView } from '../orders/order.js';
import { OrdersService } from '../orders/service.js';
import { TokensService } from '../tokens/service.js';
import {
  chargeView,
  lastTransaction,
  transactionView,
  type Charge,
  type ChargeStatus,
  type OperationType,
  type Transaction,
} from './charge.js';
import { PAYMENT_CARD_NUMBER_INVALID, type CreditCardPaymentInput, type PaymentInput } from './schemas.js';
import { initialOutcome, laterOutcome, scenarioFor, type Outcome } from './simulator-cards.js';

const CHARGE_EVENTS: Partial<Record<ChargeStatus, EventType>> = {
  paid: 'charge.paid',
  failed: 'charge.payment_failed',
  pending: 'charge.pending',
  processing: 'charge.processing',
  canceled: 'charge.refunded',
  chargedback: 'charge.chargedback',
};

/** A card ready to be charged: either already in the wallet or still to be stored. */
export type ResolvedCard = { stored: Card } | { pending: NewCard };

export interface NewCharge {
  customerId: string;
  orderId?: string;
  code: string;
  amount: number;
  payment: PaymentInput;
  card: ResolvedCard;
}

export class ChargesService {
  private readonly charges: Repository<Charge>;
  private readonly cards: CardsService;
  private readonly customers: CustomersService;
  private readonly tokens: TokensService;

  constructor(private readonly ctx: AppContext) {
    this.charges = ctx.store.repository<Charge>('charges');
    this.cards = new CardsService(ctx);
    this.customers = new CustomersService(ctx);
    this.tokens = new TokensService(ctx);
  }

  /** 404 "Charge not found." */
  get(id: string): Charge {
    const charge = this.charges.findById(id);
    if (!charge) throw new NotFoundError('Charge');
    return charge;
  }

  /**
   * Validates the card of a credit card payment before anything is charged. Tokens are consumed here.
   * `errorKey` is the payment path used in validation errors, e.g. "order.payments[0]".
   */
  resolveCard(customerId: string, payment: PaymentInput, errorKey: string, body: unknown): ResolvedCard {
    const creditCard: CreditCardPaymentInput | undefined = payment.credit_card;
    if (!creditCard) throw new Error('only credit card payments are supported');
    if (creditCard.card_id !== undefined) {
      const card = this.cards.findById(creditCard.card_id);
      if (card?.customer_id !== customerId || card.status !== 'active') throw new NotFoundError('Card');
      return { stored: card };
    }
    const billing = creditCard.card
      ? this.cards.billingAddress(
          customerId,
          creditCard.card.billing_address_id,
          creditCard.card.billing_address,
        )
      : undefined;
    if (creditCard.card_token !== undefined) {
      const token = this.tokens.consume(creditCard.card_token);
      if (!token) {
        throw new ValidationError(
          { [`${errorKey}.credit_card.card_token`]: ['The token is invalid or expired.'] },
          body,
        );
      }
      return {
        pending: { ...token.card, holder_name: token.card.holder_name ?? '', billing_address: billing },
      };
    }
    const card = creditCard.card;
    const brand = card?.number ? (detectBrand(card.number) ?? normalizeBrand(card.brand)) : undefined;
    if (
      !card?.number ||
      !card.holder_name ||
      card.exp_month === undefined ||
      card.exp_year === undefined ||
      !brand
    ) {
      throw new ValidationError({ [`${errorKey}.credit_card.card`]: [PAYMENT_CARD_NUMBER_INVALID] }, body);
    }
    return {
      pending: compact({
        number: card.number,
        brand,
        holder_name: card.holder_name,
        holder_document: card.holder_document,
        exp_month: card.exp_month,
        exp_year: card.exp_year,
        label: card.label,
        billing_address: billing,
      }),
    };
  }

  /**
   * Creates the charge and authorizes it following the simulator card rules. Events are not emitted here:
   * the caller decides their order (see emitCreated). Later transitions are scheduled.
   */
  create(input: NewCharge): Charge {
    const creditCard = input.payment.credit_card;
    if (!creditCard) throw new Error('only credit card payments are supported');
    const card =
      'stored' in input.card ? input.card.stored : this.cards.insert(input.customerId, input.card.pending);
    const operation: OperationType =
      creditCard.capture === false ? 'auth_only' : (creditCard.operation_type ?? 'auth_and_capture');
    const scenario = scenarioFor(card.number);
    const outcome = initialOutcome(scenario, operation);
    const now = formatDate(this.ctx.clock.now());

    const transaction: Transaction = compact({
      id: generateId('tran'),
      operation_key: randomDigits(9),
      transaction_type: 'credit_card' as const,
      gateway_id: randomUUID(),
      amount: input.amount,
      status: outcome.transaction,
      success: outcome.success,
      installments: creditCard.installments ?? 1,
      statement_descriptor: creditCard.statement_descriptor,
      acquirer_name: 'simulator' as const,
      acquirer_tid: randomDigits(9),
      acquirer_nsu: randomDigits(5),
      acquirer_auth_code: outcome.authorized ? randomDigits(6) : undefined,
      acquirer_message: outcome.message,
      acquirer_return_code: outcome.returnCode,
      operation_type: operation,
      card_id: card.id,
      payment_type: 'PAN' as const,
      metadata: creditCard.metadata ?? {},
      created_at: now,
      updated_at: now,
    });
    const charge = this.charges.insert(
      this.withStatus(
        compact({
          id: generateId('ch'),
          code: input.code,
          gateway_id: randomUUID(),
          order_id: input.orderId,
          customer_id: input.customerId,
          amount: input.amount,
          status: 'pending' as const,
          currency: 'BRL' as const,
          payment_method: 'credit_card' as const,
          metadata: input.payment.metadata,
          transactions: [transaction],
          created_at: now,
          updated_at: now,
        }),
        outcome.charge,
        now,
      ),
    );

    const later = laterOutcome(scenario, operation);
    if (later) {
      this.ctx.scheduler.schedule(`charge ${charge.id}: ${scenario}`, () => {
        this.transition(charge.id, later);
      });
    }
    return charge;
  }

  /** charge.created followed by the event of its current status. */
  emitCreated(charge: Charge): void {
    const view = this.view(charge, true);
    this.ctx.events.emit('charge.created', view);
    const event = CHARGE_EVENTS[charge.status];
    if (event) this.ctx.events.emit(event, view);
  }

  /** Applies a status change reported "later" by the acquirer, then updates the order. */
  transition(chargeId: string, outcome: Outcome): void {
    const charge = this.charges.findById(chargeId);
    if (!charge) return; // removed by /_simulator/reset
    const now = formatDate(this.ctx.clock.now());
    const transaction = lastTransaction(charge);
    const updated = this.charges.update(
      this.withStatus(
        {
          ...charge,
          transactions: [
            ...charge.transactions.slice(0, -1),
            compact({
              ...transaction,
              status: outcome.transaction,
              success: outcome.success,
              acquirer_message: outcome.message,
              acquirer_return_code: outcome.returnCode ?? transaction.acquirer_return_code,
              acquirer_auth_code: outcome.authorized
                ? (transaction.acquirer_auth_code ?? randomDigits(6))
                : transaction.acquirer_auth_code,
              updated_at: now,
            }),
          ],
          updated_at: now,
        },
        outcome.charge,
        now,
      ),
    );
    const event = CHARGE_EVENTS[updated.status];
    if (event) this.ctx.events.emit(event, this.view(updated, true));
    if (updated.order_id) new OrdersService(this.ctx).refreshStatus(updated.order_id);
  }

  findByIds(ids: readonly string[]): Charge[] {
    return ids.map((id) => this.get(id));
  }

  /** `withOrder`: include the order summary, as charges rendered on their own do. */
  view(charge: Charge, withOrder = false) {
    const transaction = lastTransaction(charge);
    const card = this.cards.findById(transaction.card_id);
    const order =
      withOrder && charge.order_id ? new OrdersService(this.ctx).find(charge.order_id) : undefined;
    return chargeView(charge, {
      customer: this.customers.embeddedView(this.customers.get(charge.customer_id)),
      lastTransaction: transactionView(transaction, card && cardView(card)),
      order: order && orderSummaryView(order),
    });
  }

  private withStatus(charge: Charge, status: ChargeStatus, now: string): Charge {
    return compact({
      ...charge,
      status,
      paid_amount: status === 'paid' ? charge.amount : charge.paid_amount,
      paid_at: status === 'paid' ? now : charge.paid_at,
      canceled_amount: status === 'canceled' ? charge.amount : charge.canceled_amount,
      canceled_at: status === 'canceled' ? now : charge.canceled_at,
    });
  }
}
