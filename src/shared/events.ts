/** Every event documented in docs/pagarme/reference/eventos-de-webhook-1.md (valid webhook filters). */
export const DOCUMENTED_EVENTS = [
  'customer.created',
  'customer.updated',
  'card.created',
  'card.updated',
  'card.deleted',
  'address.created',
  'address.updated',
  'address.deleted',
  'card.expired',
  'plan.created',
  'plan.updated',
  'plan.deleted',
  'plan_item.created',
  'plan_item.updated',
  'plan_item.deleted',
  'subscription.created',
  'subscription.canceled',
  'subscription_item.created',
  'subscription_item.updated',
  'subscription_item.deleted',
  'discount.created',
  'discount.deleted',
  'increment.created',
  'increment.deleted',
  'order.paid',
  'order.payment_failed',
  'order.created',
  'order.canceled',
  'order_item.created',
  'order_item.updated',
  'order_item.deleted',
  'order.closed',
  'order.updated',
  'invoice.created',
  'invoice.updated',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.canceled',
  'charge.created',
  'charge.updated',
  'charge.paid',
  'charge.payment_failed',
  'charge.refunded',
  'charge.pending',
  'charge.processing',
  'charge.underpaid',
  'charge.overpaid',
  'charge.partial_canceled',
  'charge.chargedback',
  'chargeback.received',
  'usage.created',
  'usage.deleted',
  'recipient.created',
  'recipient.deleted',
  'recipient.updated',
  'bank_account.created',
  'bank_account.updated',
  'bank_account.deleted',
  'checkout.created',
  'checkout.canceled',
  'checkout.closed',
  'charge.antifraud_approved',
  'charge.antifraud_reproved',
  'charge.antifraud_manual',
  'charge.antifraud_pending',
] as const;

/** Events the simulator emits so far. */
export type EventType =
  | 'customer.created'
  | 'customer.updated'
  | 'address.created'
  | 'address.updated'
  | 'address.deleted'
  | 'card.created'
  | 'card.updated'
  | 'card.deleted'
  | 'order.created'
  | 'order.paid'
  | 'order.payment_failed'
  | 'order.canceled'
  | 'order.closed'
  | 'order_item.created'
  | 'order_item.updated'
  | 'order_item.deleted'
  | 'charge.created'
  | 'charge.paid'
  | 'charge.payment_failed'
  | 'charge.pending'
  | 'charge.processing'
  | 'charge.refunded'
  | 'charge.chargedback'
  | 'charge.underpaid'
  | 'charge.overpaid';

export interface DomainEvent {
  type: EventType;
  /** The resource as the API renders it; becomes the webhook "data". */
  data: unknown;
}

export type EventListener = (event: DomainEvent) => void;

/** In-process pub/sub. Stage 3 subscribes the webhook dispatcher to it. */
export class EventBus {
  private readonly listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type: EventType, data: unknown): void {
    for (const listener of this.listeners) listener({ type, data });
  }
}
