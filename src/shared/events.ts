/** Events documented in docs/pagarme/reference/eventos-de-webhook-1.md that the simulator emits so far. */
export type EventType =
  | 'customer.created'
  | 'customer.updated'
  | 'address.created'
  | 'address.updated'
  | 'address.deleted'
  | 'card.created'
  | 'card.updated'
  | 'card.deleted';

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
