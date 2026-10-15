import { compact, type Metadata } from '../../shared/schemas.js';
import type { BillingAddress } from '../cards/card.js';

/**
 * docs/pagarme/reference/pedidos-1.md. "processing" is not in that list, but the card simulator guide puts the
 * order in it while a cancellation of cards …0077 and …0093 is being processed.
 */
export type OrderStatus = 'pending' | 'paid' | 'canceled' | 'failed' | 'processing';

/** docs/pagarme/reference/item-do-pedido-1.md */
export interface OrderItem {
  id: string;
  type: 'product';
  description: string;
  amount: number;
  quantity: number;
  code?: string;
  category?: string;
  status: 'active' | 'deleted';
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

/** docs/pagarme/reference/entregas-1.md */
export interface Shipping {
  amount?: number;
  description?: string;
  recipient_name?: string;
  recipient_phone?: string;
  address?: BillingAddress;
}

export interface Order {
  id: string;
  code: string;
  currency: 'BRL';
  closed: boolean;
  status: OrderStatus;
  customer_id: string;
  items: OrderItem[];
  shipping?: Shipping;
  metadata?: Metadata;
  charge_ids: string[];
  created_at: string;
  updated_at: string;
  closed_at?: string;
}

export function activeItems(order: Order): OrderItem[] {
  return order.items.filter((item) => item.status === 'active');
}

/** Items (unit amount x quantity) plus shipping. */
export function orderAmount(order: Order): number {
  const items = activeItems(order).reduce((sum, item) => sum + item.amount * item.quantity, 0);
  return items + (order.shipping?.amount ?? 0);
}

export function itemView(item: OrderItem, order?: object) {
  return compact({
    id: item.id,
    type: item.type,
    description: item.description,
    amount: item.amount,
    quantity: item.quantity,
    code: item.code,
    category: item.category,
    status: item.status,
    created_at: item.created_at,
    updated_at: item.updated_at,
    deleted_at: item.deleted_at,
    order,
  });
}

/** Order embedded in charges and items. */
export function orderSummaryView(order: Order) {
  return compact({
    id: order.id,
    code: order.code,
    amount: orderAmount(order),
    currency: order.currency,
    closed: order.closed,
    status: order.status,
    created_at: order.created_at,
    updated_at: order.updated_at,
    closed_at: order.closed_at,
  });
}

export function orderView(order: Order, parts: { customer: object; charges: object[] }) {
  return compact({
    id: order.id,
    code: order.code,
    amount: orderAmount(order),
    currency: order.currency,
    closed: order.closed,
    items: activeItems(order).map((item) => itemView(item)),
    customer: parts.customer,
    shipping: order.shipping,
    status: order.status,
    created_at: order.created_at,
    updated_at: order.updated_at,
    closed_at: order.closed_at,
    charges: parts.charges,
    checkouts: [],
    metadata: order.metadata,
  });
}
