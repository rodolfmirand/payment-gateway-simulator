import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { formatDate } from '../../shared/clock.js';
import { NotFoundError, PreconditionFailedError, ValidationError } from '../../shared/errors.js';
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
import {
  cancelOutcomes,
  initialOutcome,
  laterOutcome,
  scenarioFor,
  type Outcome,
} from './simulator-cards.js';
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

const CANNOT_CAPTURE = 'This charge can not be captured.';
const CANNOT_CANCEL = 'This charge can not be canceled.';

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

export interface ChargeFilters {
  code?: string;
  status?: string;
  payment_method?: string;
  customer_id?: string;
  order_id?: string;
  created_since?: string;
  created_until?: string;
}

/** A new transaction and the charge status it leads to; `later` is what the simulator does afterwards. */
interface Attempt {
  transaction: Transaction;
  status: ChargeStatus;
  dueAt?: string;
  later?: { label: string; run: (chargeId: string) => void };
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

  /** GET /charges (docs/pagarme/reference/listar-cobrancas.md), newest first. */
  list(filters: ChargeFilters): Charge[] {
    const since = filters.created_since === undefined ? undefined : Date.parse(filters.created_since);
    const until = filters.created_until === undefined ? undefined : Date.parse(filters.created_until);
    return this.charges
      .findAll((charge) => {
        const created = Date.parse(charge.created_at);
        return (
          (filters.code === undefined || charge.code === filters.code) &&
          (filters.status === undefined || charge.status === filters.status) &&
          (filters.payment_method === undefined || charge.payment_method === filters.payment_method) &&
          (filters.customer_id === undefined || charge.customer_id === filters.customer_id) &&
          (filters.order_id === undefined || charge.order_id === filters.order_id) &&
          (since === undefined || created >= since) &&
          (until === undefined || created <= until)
        );
      })
      .reverse();
  }

  /**
   * Validates the card of a credit card payment before anything is charged (tokens are consumed here).
   * Returns undefined for other payment methods. `creditCardKey` is the path of the credit card data in
   * validation errors, e.g. "order.payments[0].credit_card".
   */
  resolveCard(
    customerId: string,
    payment: PaymentInput,
    creditCardKey: string,
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
      if (!token)
        throw new ValidationError(
          { [`${creditCardKey}.card_token`]: ['The token is invalid or expired.'] },
          body,
        );
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
      throw new ValidationError({ [`${creditCardKey}.card`]: [PAYMENT_CARD_NUMBER_INVALID] }, body);
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
    const attempt = this.attempt(input.customerId, input.amount, input.payment, input.card, input.baseUrl);
    const now = attempt.transaction.created_at;
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
          payment_method: attempt.transaction.transaction_type,
          due_at: attempt.dueAt,
          metadata: input.payment.metadata,
          transactions: [attempt.transaction],
          created_at: now,
          updated_at: now,
        }),
        attempt.status,
        now,
      ),
    );
    this.scheduleLater(charge, attempt);
    return charge;
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

  // --- operations (docs/pagarme/reference/cobrancas-1.md) ------------------------------------------

  /** POST /charges/{id}/capture: captures an authorized card charge, fully or partially. */
  capture(id: string, amount?: number) {
    const charge = this.get(id);
    const transaction = lastTransaction(charge);
    if (
      transaction.transaction_type !== 'credit_card' ||
      transaction.status !== 'authorized_pending_capture'
    ) {
      throw new PreconditionFailedError(CANNOT_CAPTURE);
    }
    const captured = this.checkAmount(amount, transaction.amount);
    const capture = this.cardTransaction(transaction, 'capture', captured, {
      transaction: captured < transaction.amount ? 'partial_capture' : 'captured',
      charge: 'paid',
      success: true,
      message: 'Transação capturada com sucesso',
      returnCode: '00',
      authorized: true,
    });
    return this.save(this.append(charge, capture, 'paid', captured));
  }

  /**
   * DELETE /charges/{id}: cancels (before capture/payment) or refunds (after), fully or partially.
   * Boletos follow the rule in force since 2026-10-01: no refund, only the charge status changes.
   */
  cancel(id: string, amount?: number) {
    const charge = this.get(id);
    const transaction = lastTransaction(charge);
    switch (transaction.transaction_type) {
      case 'credit_card':
        return this.cancelCard(charge, transaction, amount);
      case 'pix':
        return this.cancelPix(charge, transaction, amount);
      case 'boleto':
        return this.cancelBoleto(charge, transaction);
    }
  }

  /** POST /charges/{id}/retry: authorizes a failed card charge again with the same card. */
  retry(id: string) {
    const charge = this.get(id);
    const transaction = lastTransaction(charge);
    if (charge.status !== 'failed' || transaction.transaction_type !== 'credit_card') {
      throw new PreconditionFailedError('This charge can not be retried.');
    }
    const card = this.cards.findById(transaction.card_id);
    if (!card) throw new NotFoundError('Card');
    const payment: PaymentInput = {
      payment_method: 'credit_card',
      credit_card: {
        installments: transaction.installments,
        statement_descriptor: transaction.statement_descriptor,
        operation_type: this.originalOperation(charge),
        capture: undefined,
        card: undefined,
        card_id: card.id,
        card_token: undefined,
        recurrence_cycle: undefined,
        metadata: transaction.metadata,
      },
      pix: undefined,
      boleto: undefined,
      amount: undefined,
      metadata: undefined,
    };
    return this.replaceAttempt(
      charge,
      this.attempt(charge.customer_id, charge.amount, payment, { stored: card }, ''),
    );
  }

  /**
   * PATCH /charges/{id}/card: "Esse recurso só pode ser chamado quando o cartão a ser editado teve a transação
   * não autorizada." Authorizes the charge again with the new card.
   */
  changeCard(id: string, creditCard: CreditCardPaymentInput, body: unknown) {
    const charge = this.get(id);
    const transaction = lastTransaction(charge);
    if (transaction.transaction_type !== 'credit_card' || transaction.status !== 'not_authorized') {
      throw new PreconditionFailedError('This charge may not have changed the card.');
    }
    const payment: PaymentInput = {
      payment_method: 'credit_card',
      credit_card: {
        ...creditCard,
        installments: creditCard.installments ?? transaction.installments,
        statement_descriptor: creditCard.statement_descriptor ?? transaction.statement_descriptor,
        operation_type: creditCard.operation_type ?? this.originalOperation(charge),
      },
      pix: undefined,
      boleto: undefined,
      amount: undefined,
      metadata: undefined,
    };
    const card = this.resolveCard(charge.customer_id, payment, 'charge', body);
    return this.replaceAttempt(charge, this.attempt(charge.customer_id, charge.amount, payment, card, ''));
  }

  /** PATCH /charges/{id}/payment-method: only for charges not paid yet (pending or failed). */
  changePaymentMethod(id: string, payment: PaymentInput, body: unknown, baseUrl: string) {
    const charge = this.get(id);
    if (charge.status !== 'pending' && charge.status !== 'failed') {
      throw new PreconditionFailedError("This charge can't have the payment method changed.");
    }
    const card = this.resolveCard(charge.customer_id, payment, 'charge.credit_card', body);
    return this.replaceAttempt(
      charge,
      this.attempt(charge.customer_id, charge.amount, payment, card, baseUrl),
    );
  }

  /** PATCH /charges/{id}/due-date: only for boletos not paid yet. */
  changeDueDate(id: string, dueAtInput: string) {
    const charge = this.get(id);
    const transaction = lastTransaction(charge);
    if (transaction.transaction_type !== 'boleto' || transaction.status !== 'generated') {
      throw new PreconditionFailedError('This charge can not have the due date changed.');
    }
    const now = this.now();
    const dueAt = new Date(Date.parse(dueAtInput));
    const updated: BoletoTransaction = {
      ...transaction,
      due_at: formatDate(dueAt),
      line: boletoLine(transaction.bank ?? '341', transaction.amount, dueAt),
      updated_at: now,
    };
    const saved = this.charges.update({
      ...charge,
      due_at: formatDate(dueAt),
      transactions: [...charge.transactions.slice(0, -1), updated],
      updated_at: now,
    });
    return this.view(saved, true);
  }

  // --- what happens "later" (also triggered by the /_simulator endpoints) ---------------------------

  /** Status change reported later by the acquirer for the last card transaction. */
  applyCardOutcome(chargeId: string, outcome: Outcome): void {
    const charge = this.charges.findById(chargeId);
    if (!charge) return;
    const transaction = lastTransaction(charge);
    if (transaction.transaction_type !== 'credit_card') return;
    const now = this.now();
    const updated: CardTransaction = compact({
      ...transaction,
      status: outcome.transaction,
      success: outcome.success,
      acquirer_message: outcome.message,
      acquirer_return_code: outcome.returnCode ?? transaction.acquirer_return_code,
      acquirer_auth_code: outcome.authorized
        ? (transaction.acquirer_auth_code ?? randomDigits(6))
        : transaction.acquirer_auth_code,
      updated_at: now,
    });
    const refunded = outcome.charge === 'canceled' ? (charge.paid_amount ?? charge.amount) : undefined;
    this.save(
      this.withStatus(
        { ...charge, transactions: [...charge.transactions.slice(0, -1), updated], updated_at: now },
        outcome.charge,
        now,
        undefined,
        refunded,
      ),
    );
  }

  /** The customer paid the Pix (automatic in the simulator for amounts up to R$ 500,00). */
  payPix(chargeId: string): void {
    const charge = this.charges.findById(chargeId);
    if (!charge) return;
    const transaction = lastTransaction(charge);
    if (transaction.transaction_type !== 'pix') return;
    const now = this.now();
    const paid: PixTransaction = {
      ...transaction,
      status: 'paid',
      success: true,
      end_to_end_id: endToEndId(new Date(Date.parse(now))),
      payer: this.pixPayer(this.customers.get(charge.customer_id)),
      updated_at: now,
    };
    this.save(
      this.withStatus(
        { ...charge, transactions: [...charge.transactions.slice(0, -1), paid], updated_at: now },
        'paid',
        now,
      ),
    );
  }

  /** The bank reports the payment of the boleto (full, under or over the amount). */
  conciliateBoleto(chargeId: string, scenario: Exclude<BoletoScenario, 'not_conciliated'>): void {
    const charge = this.charges.findById(chargeId);
    if (!charge) return;
    const transaction = lastTransaction(charge);
    if (transaction.transaction_type !== 'boleto') return;
    const now = this.now();
    const paidAmount = boletoPaidAmount(scenario, charge.amount);
    const paid: BoletoTransaction = {
      ...transaction,
      status: scenario,
      paid_amount: paidAmount,
      paid_at: now,
      updated_at: now,
    };
    this.save(
      this.withStatus(
        { ...charge, transactions: [...charge.transactions.slice(0, -1), paid], updated_at: now },
        scenario,
        now,
        paidAmount,
      ),
    );
  }

  // --- building transactions -----------------------------------------------------------------------

  private attempt(
    customerId: string,
    amount: number,
    payment: PaymentInput,
    card: ResolvedCard | undefined,
    baseUrl: string,
  ): Attempt {
    if (payment.payment_method === 'pix' && payment.pix) return this.pixAttempt(amount, payment.pix, baseUrl);
    if (payment.payment_method === 'boleto' && payment.boleto) {
      return this.boletoAttempt(customerId, amount, payment.boleto, baseUrl);
    }
    if (payment.payment_method === 'credit_card' && payment.credit_card && card) {
      return this.cardAttempt(customerId, amount, payment.credit_card, card);
    }
    throw new Error(`incomplete ${payment.payment_method} payment`);
  }

  private cardAttempt(
    customerId: string,
    amount: number,
    creditCard: CreditCardPaymentInput,
    resolved: ResolvedCard,
  ): Attempt {
    const card = 'stored' in resolved ? resolved.stored : this.cards.insert(customerId, resolved.pending);
    const operation: OperationType =
      creditCard.capture === false ? 'auth_only' : (creditCard.operation_type ?? 'auth_and_capture');
    const scenario = scenarioFor(card.number);
    const outcome = initialOutcome(scenario, operation);
    const transaction = this.cardTransaction(
      {
        card_id: card.id,
        installments: creditCard.installments ?? 1,
        statement_descriptor: creditCard.statement_descriptor,
        metadata: creditCard.metadata ?? {},
      },
      operation,
      amount,
      outcome,
    );
    const later = laterOutcome(scenario, operation);
    return {
      transaction,
      status: outcome.charge,
      later: later && {
        label: scenario,
        run: (chargeId) => {
          this.applyCardOutcome(chargeId, later);
        },
      },
    };
  }

  private cardTransaction(
    base: Pick<
      CardTransaction,
      'card_id' | 'installments' | 'statement_descriptor' | 'metadata' | 'acquirer_auth_code'
    >,
    operation: CardTransaction['operation_type'],
    amount: number,
    outcome: Outcome,
  ): CardTransaction {
    const now = this.now();
    return compact({
      id: generateId('tran'),
      operation_key: randomDigits(9),
      transaction_type: 'credit_card' as const,
      gateway_id: randomUUID(),
      amount,
      status: outcome.transaction,
      success: outcome.success,
      installments: base.installments,
      statement_descriptor: base.statement_descriptor,
      acquirer_name: 'simulator' as const,
      acquirer_tid: randomDigits(9),
      acquirer_nsu: randomDigits(5),
      // Captures and cancellations keep the code of the authorization they refer to.
      acquirer_auth_code: base.acquirer_auth_code ?? (outcome.authorized ? randomDigits(6) : undefined),
      acquirer_message: outcome.message,
      acquirer_return_code: outcome.returnCode,
      operation_type: operation,
      card_id: base.card_id,
      payment_type: 'PAN' as const,
      metadata: base.metadata,
      created_at: now,
      updated_at: now,
    });
  }

  private pixAttempt(amount: number, pix: PixPaymentInput, baseUrl: string): Attempt {
    const now = this.ctx.clock.now();
    const id = generateId('tran');
    const succeeds = pixSucceeds(amount);
    const expiresAt =
      pix.expires_at === undefined
        ? new Date(now.getTime() + (pix.expires_in ?? 0) * 1000)
        : new Date(Date.parse(pix.expires_at));
    const transaction: PixTransaction = compact({
      id,
      transaction_type: 'pix' as const,
      gateway_id: randomUUID(),
      amount,
      status: succeeds ? ('waiting_payment' as const) : ('failed' as const),
      success: succeeds,
      qr_code: pixQrCode(amount, this.ctx.config.account.name),
      qr_code_url: `${baseUrl}/core/v5/transactions/${id}/qrcode?payment_method=pix`,
      expires_at: formatDate(expiresAt),
      additional_information: pix.additional_information,
      metadata: {},
      created_at: formatDate(now),
      updated_at: formatDate(now),
    });
    return {
      transaction,
      status: succeeds ? 'pending' : 'failed',
      later: succeeds
        ? {
            label: 'pix paid',
            run: (chargeId) => {
              this.payPix(chargeId);
            },
          }
        : undefined,
    };
  }

  private boletoAttempt(
    customerId: string,
    amount: number,
    boleto: BoletoPaymentInput,
    baseUrl: string,
  ): Attempt {
    const now = this.ctx.clock.now();
    const id = generateId('tran');
    const dueAt =
      boleto.due_at === undefined
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + DEFAULT_BOLETO_DAYS))
        : new Date(Date.parse(boleto.due_at));
    const files = `${baseUrl}/core/v5/transactions/${id}`;
    const transaction: BoletoTransaction = compact({
      id,
      transaction_type: 'boleto' as const,
      gateway_id: randomUUID(),
      amount,
      status: 'generated' as const,
      success: true,
      url: `${files}/boleto`,
      pdf: `${files}/pdf`,
      line: boletoLine(boleto.bank ?? '341', amount, dueAt),
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
    const scenario = boletoScenario(this.customerZipCode(customerId));
    return {
      transaction,
      status: 'pending',
      dueAt: formatDate(dueAt),
      later:
        scenario === 'not_conciliated'
          ? undefined
          : {
              label: `boleto ${scenario}`,
              run: (chargeId) => {
                this.conciliateBoleto(chargeId, scenario);
              },
            },
    };
  }

  // --- cancellation ----------------------------------------------------------------------------------

  private cancelCard(charge: Charge, transaction: CardTransaction, amount: number | undefined) {
    if (charge.status === 'pending' && transaction.status === 'authorized_pending_capture') {
      // Not captured yet: the authorization is voided.
      const voided = this.checkAmount(amount, transaction.amount);
      const full = voided === transaction.amount;
      const cancel = this.cardTransaction(transaction, 'cancel', voided, {
        transaction: full ? 'voided' : 'partial_void',
        charge: full ? 'canceled' : 'pending',
        success: true,
        message: 'Transação cancelada com sucesso',
        returnCode: '00',
        authorized: false,
      });
      return this.save(
        this.append(charge, cancel, full ? 'canceled' : 'pending', undefined, voided),
        full ? 'charge.refunded' : 'charge.partial_canceled',
      );
    }
    if (charge.status !== 'paid') throw new PreconditionFailedError(CANNOT_CANCEL);

    const card = this.cards.findById(transaction.card_id);
    const special = card && cancelOutcomes(scenarioFor(card.number));
    const refundable = (charge.paid_amount ?? charge.amount) - (charge.canceled_amount ?? 0);
    const refunded = this.checkAmount(amount, refundable);
    if (special) {
      // Cards …0077 / …0093: the cancellation goes through "processing" first.
      const cancel = this.cardTransaction(transaction, 'cancel', refunded, special.now);
      if (charge.order_id) new OrdersService(this.ctx).markProcessing(charge.order_id);
      const saved = this.save(this.append(charge, cancel, 'processing'));
      this.scheduleLater(this.get(charge.id), {
        transaction: cancel,
        status: 'processing',
        later: {
          label: `cancel ${special.later.charge}`,
          run: (chargeId) => {
            this.applyCardOutcome(chargeId, special.later);
          },
        },
      });
      return saved;
    }

    const total = (charge.canceled_amount ?? 0) + refunded;
    const full = total >= (charge.paid_amount ?? charge.amount);
    const cancel = this.cardTransaction(transaction, 'cancel', refunded, {
      transaction: full ? 'refunded' : 'partial_refunded',
      charge: full ? 'canceled' : 'paid',
      success: true,
      message: 'Transação estornada com sucesso',
      returnCode: '00',
      authorized: false,
    });
    return this.save(
      this.append(charge, cancel, full ? 'canceled' : 'paid', undefined, total),
      full ? 'charge.refunded' : 'charge.partial_canceled',
    );
  }

  private cancelPix(charge: Charge, transaction: PixTransaction, amount: number | undefined) {
    const now = this.now();
    if (transaction.status === 'waiting_payment') {
      const voided: PixTransaction = { ...transaction, status: 'voided', success: true, updated_at: now };
      return this.save(this.replaceLast(charge, voided, 'canceled', now, charge.amount));
    }
    if (charge.status !== 'paid') throw new PreconditionFailedError(CANNOT_CANCEL);
    // Pix refunds can be partial, "sem limitação de vezes" (docs/pagarme/guides/pix-1.md).
    const refundable = (charge.paid_amount ?? charge.amount) - (charge.canceled_amount ?? 0);
    const total = (charge.canceled_amount ?? 0) + this.checkAmount(amount, refundable);
    const full = total >= (charge.paid_amount ?? charge.amount);
    const refunded: PixTransaction = {
      ...transaction,
      status: full ? 'refunded' : 'partial_refunded',
      updated_at: now,
    };
    return this.save(
      this.replaceLast(charge, refunded, full ? 'canceled' : 'paid', now, total),
      full ? 'charge.refunded' : 'charge.partial_canceled',
    );
  }

  /**
   * Since 2026-10-01 (reference/cancelar-cobranca.md): an unpaid boleto is written off and can no longer be
   * paid; for a paid one only the charge status changes, nothing is refunded.
   */
  private cancelBoleto(charge: Charge, transaction: BoletoTransaction) {
    const now = this.now();
    if (transaction.status === 'generated') {
      const voided: BoletoTransaction = { ...transaction, status: 'voided', updated_at: now };
      return this.save(this.replaceLast(charge, voided, 'canceled', now, charge.amount));
    }
    if (!['paid', 'underpaid', 'overpaid'].includes(charge.status))
      throw new PreconditionFailedError(CANNOT_CANCEL);
    return this.save(
      this.replaceLast(charge, transaction, 'canceled', now, charge.paid_amount ?? charge.amount),
    );
  }

  // --- shared ----------------------------------------------------------------------------------------

  /** Validates an optional partial amount against the maximum allowed. */
  private checkAmount(amount: number | undefined, maximum: number): number {
    if (amount === undefined) return maximum;
    if (amount > maximum) {
      throw new ValidationError(
        { 'charge.amount': [`The field amount must be less than or equal to ${maximum}`] },
        { amount },
      );
    }
    return amount;
  }

  /** Operation of the first authorization of the charge (retries keep it). */
  private originalOperation(charge: Charge): OperationType {
    const first = charge.transactions[0];
    return first?.transaction_type === 'credit_card' &&
      (first.operation_type === 'auth_only' || first.operation_type === 'pre_auth')
      ? first.operation_type
      : 'auth_and_capture';
  }

  /** A new attempt on an existing charge (retry, new card, new payment method). */
  private replaceAttempt(charge: Charge, attempt: Attempt) {
    const updated = this.withStatus(
      compact({
        ...charge,
        payment_method: attempt.transaction.transaction_type,
        due_at: attempt.dueAt,
        transactions: [...charge.transactions, attempt.transaction],
        updated_at: attempt.transaction.created_at,
      }),
      attempt.status,
      attempt.transaction.created_at,
    );
    const saved = this.save(updated);
    this.scheduleLater(this.get(charge.id), attempt);
    return saved;
  }

  private append(
    charge: Charge,
    transaction: Transaction,
    status: ChargeStatus,
    paidAmount?: number,
    canceledAmount?: number,
  ): Charge {
    return this.withStatus(
      { ...charge, transactions: [...charge.transactions, transaction], updated_at: transaction.created_at },
      status,
      transaction.created_at,
      paidAmount,
      canceledAmount,
    );
  }

  private replaceLast(
    charge: Charge,
    transaction: Transaction,
    status: ChargeStatus,
    now: string,
    canceledAmount?: number,
  ): Charge {
    return this.withStatus(
      { ...charge, transactions: [...charge.transactions.slice(0, -1), transaction], updated_at: now },
      status,
      now,
      undefined,
      canceledAmount,
    );
  }

  /**
   * Schedules what the simulator does later. It is skipped if the charge changed in the meantime
   * (e.g. a boleto canceled before being conciliated).
   */
  private scheduleLater(charge: Charge, attempt: Attempt): void {
    const { later } = attempt;
    if (!later) return;
    const expected = { status: charge.status, transactions: charge.transactions.length };
    this.ctx.scheduler.schedule(`charge ${charge.id}: ${later.label}`, () => {
      const current = this.charges.findById(charge.id);
      if (current?.status !== expected.status || current.transactions.length !== expected.transactions)
        return;
      later.run(charge.id);
    });
  }

  /** Persists the charge, emits the event of its status (or `event`) and updates the order. */
  private save(charge: Charge, event: EventType | undefined = CHARGE_EVENTS[charge.status]) {
    const saved = this.charges.update(charge);
    const emitOrderEvent = saved.order_id
      ? new OrdersService(this.ctx).refreshStatus(saved.order_id)
      : undefined;
    const view = this.view(saved, true);
    if (event) this.ctx.events.emit(event, view);
    emitOrderEvent?.();
    return view;
  }

  private withStatus(
    charge: Charge,
    status: ChargeStatus,
    now: string,
    paidAmount?: number,
    canceledAmount?: number,
  ): Charge {
    const paid = status === 'paid' || status === 'underpaid' || status === 'overpaid';
    const canceled = canceledAmount !== undefined || status === 'canceled';
    return compact({
      ...charge,
      status,
      paid_amount:
        paid && charge.paid_amount === undefined ? (paidAmount ?? charge.amount) : charge.paid_amount,
      paid_at: paid && charge.paid_at === undefined ? now : charge.paid_at,
      canceled_amount: canceled ? (canceledAmount ?? charge.amount) : charge.canceled_amount,
      canceled_at: status === 'canceled' ? now : charge.canceled_at,
    });
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

  private customerZipCode(customerId: string): string | undefined {
    const customer = this.customers.get(customerId);
    return customer.address_id
      ? new AddressesService(this.ctx).findById(customer.address_id)?.zip_code
      : undefined;
  }

  private now(): string {
    return formatDate(this.ctx.clock.now());
  }
}
