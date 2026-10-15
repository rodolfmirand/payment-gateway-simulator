import { compact, type Metadata } from '../../shared/schemas.js';

/** docs/pagarme/reference/cobrancas-1.md */
export type ChargeStatus =
  'pending' | 'paid' | 'canceled' | 'processing' | 'failed' | 'overpaid' | 'underpaid' | 'chargedback';

/** docs/pagarme/reference/cartao-de-credito-1.md ("Status da transação de cartão de crédito") */
export type TransactionStatus =
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

export type OperationType = 'auth_and_capture' | 'auth_only' | 'pre_auth';

export interface Transaction {
  id: string;
  operation_key: string;
  transaction_type: 'credit_card';
  gateway_id: string;
  amount: number;
  status: TransactionStatus;
  success: boolean;
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
  metadata: Metadata;
  created_at: string;
  updated_at: string;
}

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
  payment_method: 'credit_card';
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

export function transactionView(transaction: Transaction, card: object | undefined) {
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
    created_at: transaction.created_at,
    updated_at: transaction.updated_at,
    gateway_response: { code: '200', errors: [] },
    antifraud_response: {},
    metadata: transaction.metadata,
  });
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
