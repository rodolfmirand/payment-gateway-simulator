import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { formatDate } from '../../shared/clock.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import type { EventType } from '../../shared/events.js';
import { generateId, randomDigits } from '../../shared/ids.js';
import { compact } from '../../shared/schemas.js';
import type { Repository } from '../../shared/store/repository.js';
import { AddressesService } from '../addresses/service.js';
import { detectBrand, normalizeBrand } from '../cards/card-number.js';
import { cardView, type Card } from '../cards/card.js';
import { CardsService, type NewCard } from '../cards/service.js';
import type { Customer } from '../customers/customer.js';
import { CustomersService } from '../customers/service.js';
import { orderSummaryView } from '../orders/order.js';
import { OrdersService } from '../orders/service.js';
import { TokensService } from '../tokens/service.js';
import {
  chargeView,
  lastTransaction,
  transactionView,
  type BoletoTransaction,
  type CardTransaction,
  type Charge,
  type ChargeStatus,
  type OperationType,
  type PixTransaction,
  type Transaction,
} from './charge.js';
import { boletoLine, endToEndId, pixQrCode } from './documents.js';
import {
  PAYMENT_CARD_NUMBER_INVALID,
  type BoletoPaymentInput,
  type CreditCardPaymentInput,
  type PaymentInput,
  type PixPaymentInput,
} from './schemas.js';
import { initialOutcome, laterOutcome, scenarioFor, type Outcome } from './simulator-cards.js';
import { boletoPaidAmount, boletoScenario, pixSucceeds, type BoletoScenario } from './simulator-payments.js';

const CHARGE_EVENTS: Partial<Record<ChargeStatus, EventType>> = {
  paid: 'charge.paid',
  failed: 'charge.payment_failed',
  pending: 'charge.pending',
  processing: 'charge.processing',
  canceled: 'charge.refunded',
  chargedback: 'charge.chargedback',
  underpaid: 'charge.underpaid',
  overpaid: 'charge.overpaid',
};

/** The guides do not say when a boleto is due if `due_at` is not sent: the simulator uses 3 days. */
const DEFAULT_BOLETO_DAYS = 3;

/** A card ready to be charged: either already in the wallet or still to be stored. */
export type ResolvedCard = { stored: Card } | { pending: NewCard };

export interface NewCharge {
  customerId: string;
  orderId?: string;
  code: string;
  amount: number;
  payment: PaymentInput;
  /** Required for credit card payments (see resolveCard). */
  card?: ResolvedCard;
  /** Public URL of the simulator, used in qr_code_url, pdf, barcode... */
  baseUrl: string;
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

  findByIds(ids: readonly string[]): Charge[] {
    return ids.map((id) => this.get(id));
  }

  /** The charge holding a transaction (used to serve the Pix QR Code and boleto files). */
  findByTransaction(transactionId: string): { charge: Charge; transaction: Transaction } | undefined {
    for (const charge of this.charges.findAll()) {
      const transaction = charge.transactions.find((candidate) => candidate.id === transactionId);
      if (transaction) return { charge, transaction };
    }
    return undefined;
  }

  /**
   * Validates the card of a credit card payment before anything is charged (tokens are consumed here).
   * Returns undefined for other payment methods. `errorKey` is the payment path in validation errors,
   * e.g. "order.payments[0]".
   */
  resolveCard(
    customerId: string,
    payment: PaymentInput,
    errorKey: string,
    body: unknown,
  ): ResolvedCard | undefined {
    const creditCard: CreditCardPaymentInput | undefined = payment.credit_card;
    if (payment.payment_method !== 'credit_card' || !creditCard) return undefined;
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
   * Creates the charge following the simulator rules of its payment method. Events are not emitted here:
   * the caller decides their order (see emitCreated). What happens "later" is scheduled.
   */
  create(input: NewCharge): Charge {
    const { payment } = input;
    if (payment.payment_method === 'pix' && payment.pix) return this.createPix(input, payment.pix);
    if (payment.payment_method === 'boleto' && payment.boleto)
      return this.createBoleto(input, payment.boleto);
    if (payment.payment_method === 'credit_card' && payment.credit_card && input.card) {
      return this.createCreditCard(input, payment.credit_card, input.card);
    }
    throw new Error(`incomplete ${payment.payment_method} payment`);
  }

  /** charge.created followed by the event of its current status. */
  emitCreated(charge: Charge): void {
    const view = this.view(charge, true);
    this.ctx.events.emit('charge.created', view);
    const event = CHARGE_EVENTS[charge.status];
    if (event) this.ctx.events.emit(event, view);
  }

  /** `withOrder`: include the order summary, as charges rendered on their own do. */
  view(charge: Charge, withOrder = false) {
    const transaction = lastTransaction(charge);
    const card =
      transaction.transaction_type === 'credit_card' ? this.cards.findById(transaction.card_id) : undefined;
    const order =
      withOrder && charge.order_id ? new OrdersService(this.ctx).find(charge.order_id) : undefined;
    return chargeView(charge, {
      customer: this.customers.embeddedView(this.customers.get(charge.customer_id)),
      lastTransaction: transactionView(transaction, card && cardView(card)),
      order: order && orderSummaryView(order),
    });
  }

  // --- credit card -------------------------------------------------------------------------------

  private createCreditCard(
    input: NewCharge,
    creditCard: CreditCardPaymentInput,
    resolved: ResolvedCard,
  ): Charge {
    const card =
      'stored' in resolved ? resolved.stored : this.cards.insert(input.customerId, resolved.pending);
    const operation: OperationType =
      creditCard.capture === false ? 'auth_only' : (creditCard.operation_type ?? 'auth_and_capture');
    const scenario = scenarioFor(card.number);
    const outcome = initialOutcome(scenario, operation);
    const now = this.now();
    const transaction: CardTransaction = compact({
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
    const charge = this.insert(input, transaction, outcome.charge);

    const later = laterOutcome(scenario, operation);
    if (later) {
      this.ctx.scheduler.schedule(`charge ${charge.id}: ${scenario}`, () => {
        this.applyCardOutcome(charge.id, later);
      });
    }
    return charge;
  }

  /** Status change reported "later" by the acquirer. */
  applyCardOutcome(chargeId: string, outcome: Outcome): void {
    this.updateCharge(chargeId, outcome.charge, (transaction, now) =>
      transaction.transaction_type !== 'credit_card'
        ? transaction
        : compact({
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
    );
  }

  // --- pix ---------------------------------------------------------------------------------------

  private createPix(input: NewCharge, pix: PixPaymentInput): Charge {
    const now = this.ctx.clock.now();
    const id = generateId('tran');
    const succeeds = pixSucceeds(input.amount);
    const expiresAt =
      pix.expires_at === undefined
        ? new Date(now.getTime() + (pix.expires_in ?? 0) * 1000)
        : new Date(Date.parse(pix.expires_at));
    const transaction: PixTransaction = compact({
      id,
      transaction_type: 'pix' as const,
      gateway_id: randomUUID(),
      amount: input.amount,
      status: succeeds ? ('waiting_payment' as const) : ('failed' as const),
      success: succeeds,
      qr_code: pixQrCode(input.amount, this.ctx.config.account.name),
      qr_code_url: `${input.baseUrl}/core/v5/transactions/${id}/qrcode?payment_method=pix`,
      expires_at: formatDate(expiresAt),
      additional_information: pix.additional_information,
      metadata: {},
      created_at: formatDate(now),
      updated_at: formatDate(now),
    });
    const charge = this.insert(input, transaction, succeeds ? 'pending' : 'failed');
    if (succeeds) {
      this.ctx.scheduler.schedule(`charge ${charge.id}: pix paid`, () => {
        this.payPix(charge.id);
      });
    }
    return charge;
  }

  /** The customer paid the Pix (automatic in the simulator for amounts up to R$ 500,00). */
  payPix(chargeId: string): void {
    const charge = this.charges.findById(chargeId);
    if (!charge) return;
    const payer = this.pixPayer(this.customers.get(charge.customer_id));
    this.updateCharge(chargeId, 'paid', (transaction, now) =>
      transaction.transaction_type !== 'pix'
        ? transaction
        : {
            ...transaction,
            status: 'paid',
            success: true,
            end_to_end_id: endToEndId(new Date(Date.parse(now))),
            payer,
            updated_at: now,
          },
    );
  }

  private pixPayer(customer: Customer) {
    const digits = (customer.document ?? '').replace(/\D/g, '');
    return {
      name: customer.name,
      document_type: customer.document_type ?? (digits.length > 11 ? 'CNPJ' : 'CPF'),
      document: digits.length === 11 ? `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**` : '***',
      bank_account: { bank_name: 'Pagarme', ispb: '18236120' },
    };
  }

  // --- boleto ------------------------------------------------------------------------------------

  private createBoleto(input: NewCharge, boleto: BoletoPaymentInput): Charge {
    const now = this.ctx.clock.now();
    const id = generateId('tran');
    const dueAt =
      boleto.due_at === undefined
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + DEFAULT_BOLETO_DAYS))
        : new Date(Date.parse(boleto.due_at));
    const files = `${input.baseUrl}/core/v5/transactions/${id}`;
    const transaction: BoletoTransaction = compact({
      id,
      transaction_type: 'boleto' as const,
      gateway_id: randomUUID(),
      amount: input.amount,
      status: 'generated' as const,
      success: true,
      url: `${files}/boleto`,
      pdf: `${files}/pdf`,
      line: boletoLine(boleto.bank ?? '341', input.amount, dueAt),
      barcode: `${files}/barcode`,
      qr_code: `${files}/qrcode`,
      nosso_numero: boleto.nosso_numero ?? randomDigits(8),
      bank: boleto.bank,
      type: boleto.type ?? 'DM',
      document_number: boleto.document_number,
      instructions: boleto.instructions,
      statement_descriptor: boleto.statement_descriptor,
      due_at: formatDate(dueAt),
      metadata: boleto.metadata ?? {},
      created_at: formatDate(now),
      updated_at: formatDate(now),
    });
    const charge = this.insert({ ...input }, transaction, 'pending', formatDate(dueAt));

    const scenario = boletoScenario(this.customerZipCode(input.customerId));
    if (scenario !== 'not_conciliated') {
      this.ctx.scheduler.schedule(`charge ${charge.id}: boleto ${scenario}`, () => {
        this.conciliateBoleto(charge.id, scenario);
      });
    }
    return charge;
  }

  /** The bank reports the payment of the boleto (full, under or over the amount). */
  conciliateBoleto(chargeId: string, scenario: Exclude<BoletoScenario, 'not_conciliated'>): void {
    const charge = this.charges.findById(chargeId);
    if (!charge) return;
    const paidAmount = boletoPaidAmount(scenario, charge.amount);
    this.updateCharge(
      chargeId,
      scenario,
      (transaction, now) =>
        transaction.transaction_type !== 'boleto'
          ? transaction
          : { ...transaction, status: scenario, paid_amount: paidAmount, paid_at: now, updated_at: now },
      paidAmount,
    );
  }

  private customerZipCode(customerId: string): string | undefined {
    const customer = this.customers.get(customerId);
    return customer.address_id
      ? new AddressesService(this.ctx).findById(customer.address_id)?.zip_code
      : undefined;
  }

  // --- shared ------------------------------------------------------------------------------------

  private insert(input: NewCharge, transaction: Transaction, status: ChargeStatus, dueAt?: string): Charge {
    const now = transaction.created_at;
    return this.charges.insert(
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
          payment_method: transaction.transaction_type,
          due_at: dueAt,
          metadata: input.payment.metadata,
          transactions: [transaction],
          created_at: now,
          updated_at: now,
        }),
        status,
        now,
      ),
    );
  }

  /** Changes the status of a charge and its last transaction, emits the charge event and updates the order. */
  private updateCharge(
    chargeId: string,
    status: ChargeStatus,
    changeTransaction: (transaction: Transaction, now: string) => Transaction,
    paidAmount?: number,
  ): void {
    const charge = this.charges.findById(chargeId);
    if (!charge) return; // removed by /_simulator/reset
    const now = this.now();
    const updated = this.charges.update(
      this.withStatus(
        {
          ...charge,
          transactions: [
            ...charge.transactions.slice(0, -1),
            changeTransaction(lastTransaction(charge), now),
          ],
          updated_at: now,
        },
        status,
        now,
        paidAmount,
      ),
    );
    const event = CHARGE_EVENTS[updated.status];
    if (event) this.ctx.events.emit(event, this.view(updated, true));
    if (updated.order_id) new OrdersService(this.ctx).refreshStatus(updated.order_id);
  }

  private withStatus(charge: Charge, status: ChargeStatus, now: string, paidAmount?: number): Charge {
    const paid = status === 'paid' || status === 'underpaid' || status === 'overpaid';
    return compact({
      ...charge,
      status,
      paid_amount: paid ? (paidAmount ?? charge.amount) : charge.paid_amount,
      paid_at: paid ? now : charge.paid_at,
      canceled_amount: status === 'canceled' ? charge.amount : charge.canceled_amount,
      canceled_at: status === 'canceled' ? now : charge.canceled_at,
    });
  }

  private now(): string {
    return formatDate(this.ctx.clock.now());
  }
}
