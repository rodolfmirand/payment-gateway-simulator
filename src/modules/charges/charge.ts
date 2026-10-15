import { compact, type Metadata } from '../../shared/schemas.js';

/** docs/pagarme/reference/cobrancas-1.md */
export type ChargeStatus =
  'pending' | 'paid' | 'canceled' | 'processing' | 'failed' | 'overpaid' | 'underpaid' | 'chargedback';

/** docs/pagarme/reference/cartao-de-credito-1.md ("Status da transação de cartão de crédito") */
export type CardTransactionStatus =
  | 'authorized_pending_capture'
  | 'not_authorized'
  | 'captured'
  | 'partial_capture'
  | 'waiting_capture'
  | 'refunded'
  | 'voided'
  | 'partial_refunded'
  | 'partial_void'
  | 'error_on_voiding'
  | 'error_on_refunding'
  | 'waiting_cancellation'
  | 'with_error'
  | 'failed'
  | 'chargedback';

/** As in docs/pagarme/reference/pix-2.md: waiting_payment until paid. */
export type PixTransactionStatus = 'waiting_payment' | 'paid' | 'failed' | 'refunded';

/** As in docs/pagarme/reference/boleto-1.md: generated until conciliated. */
export type BoletoTransactionStatus = 'generated' | 'paid' | 'underpaid' | 'overpaid' | 'voided' | 'failed';

export type TransactionStatus = CardTransactionStatus | PixTransactionStatus | BoletoTransactionStatus;

export type OperationType = 'auth_and_capture' | 'auth_only' | 'pre_auth';

interface BaseTransaction {
  id: string;
  gateway_id: string;
  amount: number;
  success: boolean;
  metadata: Metadata;
  created_at: string;
  updated_at: string;
}

export interface CardTransaction extends BaseTransaction {
  transaction_type: 'credit_card';
  operation_key: string;
  status: CardTransactionStatus;
  installments: number;
  statement_descriptor?: string;
  acquirer_name: 'simulator';
  acquirer_tid: string;
  acquirer_nsu: string;
  acquirer_auth_code?: string;
  acquirer_message: string;
  acquirer_return_code?: string;
  operation_type: OperationType | 'capture' | 'cancel';
  card_id: string;
  payment_type: 'PAN';
}

export interface PixPayer {
  name: string;
  document_type: string;
  document: string;
  bank_account: { bank_name: string; ispb: string };
}

export interface PixTransaction extends BaseTransaction {
  transaction_type: 'pix';
  status: PixTransactionStatus;
  qr_code: string;
  qr_code_url: string;
  expires_at: string;
  additional_information?: { name: string; value: string }[];
  end_to_end_id?: string;
  payer?: PixPayer;
}

export interface BoletoTransaction extends BaseTransaction {
  transaction_type: 'boleto';
  status: BoletoTransactionStatus;
  url: string;
  pdf: string;
  line: string;
  barcode: string;
  qr_code: string;
  nosso_numero: string;
  bank?: string;
  type: string;
  document_number?: string;
  instructions?: string;
  statement_descriptor?: string;
  due_at: string;
  paid_amount?: number;
  paid_at?: string;
}

export type Transaction = CardTransaction | PixTransaction | BoletoTransaction;
export type PaymentMethod = Transaction['transaction_type'];

export interface Charge {
  id: string;
  code: string;
  gateway_id: string;
  order_id?: string;
  customer_id: string;
  amount: number;
  paid_amount?: number;
  canceled_amount?: number;
  status: ChargeStatus;
  currency: 'BRL';
  payment_method: PaymentMethod;
  due_at?: string;
  paid_at?: string;
  canceled_at?: string;
  metadata?: Metadata;
  /** Oldest first; the last one is rendered as `last_transaction`. */
  transactions: Transaction[];
  created_at: string;
  updated_at: string;
}

export function lastTransaction(charge: Charge): Transaction {
  const last = charge.transactions.at(-1);
  if (!last) throw new Error(`Charge ${charge.id} has no transaction`);
  return last;
}

/** Fields shared by every transaction, at the end of the object as in the official examples. */
function tail(transaction: Transaction, gatewayResponse: object) {
  return {
    created_at: transaction.created_at,
    updated_at: transaction.updated_at,
    gateway_response: gatewayResponse,
    antifraud_response: {},
    metadata: transaction.metadata,
  };
}

/** `card` is the rendered card of a credit card transaction. */
export function transactionView(transaction: Transaction, card?: object) {
  switch (transaction.transaction_type) {
    case 'credit_card':
      return compact({
        operation_key: transaction.operation_key,
        id: transaction.id,
        transaction_type: transaction.transaction_type,
        gateway_id: transaction.gateway_id,
        amount: transaction.amount,
        status: transaction.status,
        success: transaction.success,
        installments: transaction.installments,
        statement_descriptor: transaction.statement_descriptor,
        acquirer_name: transaction.acquirer_name,
        acquirer_tid: transaction.acquirer_tid,
        acquirer_nsu: transaction.acquirer_nsu,
        acquirer_auth_code: transaction.acquirer_auth_code,
        acquirer_message: transaction.acquirer_message,
        acquirer_return_code: transaction.acquirer_return_code,
        operation_type: transaction.operation_type,
        card,
        payment_type: transaction.payment_type,
        ...tail(transaction, { code: '200', errors: [] }),
      });
    case 'pix':
      return compact({
        qr_code: transaction.qr_code,
        qr_code_url: transaction.qr_code_url,
        expires_at: transaction.expires_at,
        additional_information: transaction.additional_information,
        end_to_end_id: transaction.end_to_end_id,
        payer: transaction.payer,
        id: transaction.id,
        transaction_type: transaction.transaction_type,
        gateway_id: transaction.gateway_id,
        amount: transaction.amount,
        status: transaction.status,
        success: transaction.success,
        ...tail(transaction, {}),
      });
    case 'boleto':
      return compact({
        id: transaction.id,
        transaction_type: transaction.transaction_type,
        gateway_id: transaction.gateway_id,
        amount: transaction.amount,
        status: transaction.status,
        success: transaction.success,
        url: transaction.url,
        pdf: transaction.pdf,
        line: transaction.line,
        barcode: transaction.barcode,
        qr_code: transaction.qr_code,
        nosso_numero: transaction.nosso_numero,
        bank: transaction.bank,
        type: transaction.type,
        document_number: transaction.document_number,
        instructions: transaction.instructions,
        statement_descriptor: transaction.statement_descriptor,
        due_at: transaction.due_at,
        paid_amount: transaction.paid_amount,
        paid_at: transaction.paid_at,
        ...tail(transaction, { code: '201' }),
      });
  }
}

/**
 * Charge as rendered by the API. Inside an order the `order` summary is omitted; on its own
 * (POST /charges) it carries it, as in the official example.
 */
export function chargeView(
  charge: Charge,
  parts: { customer: object; lastTransaction: object; order?: object },
) {
  return compact({
    id: charge.id,
    code: charge.code,
    gateway_id: charge.gateway_id,
    amount: charge.amount,
    paid_amount: charge.paid_amount,
    canceled_amount: charge.canceled_amount,
    status: charge.status,
    currency: charge.currency,
    payment_method: charge.payment_method,
    due_at: charge.due_at,
    paid_at: charge.paid_at,
    canceled_at: charge.canceled_at,
    created_at: charge.created_at,
    updated_at: charge.updated_at,
    order: parts.order,
    customer: parts.customer,
    last_transaction: parts.lastTransaction,
    metadata: charge.metadata,
  });
}
