import type { AppContext } from '../../context.js';
import { formatDate } from '../../shared/clock.js';
import {
  BadRequestError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  type FieldErrors,
} from '../../shared/errors.js';
import type { EventType } from '../../shared/events.js';
import { generateId, randomCode } from '../../shared/ids.js';
import { compact } from '../../shared/schemas.js';
import type { Repository } from '../../shared/store/repository.js';
import type { ChargeStatus } from '../charges/charge.js';
import type { PaymentInput } from '../charges/schemas.js';
import { ChargesService } from '../charges/service.js';
import type { CustomerInput } from '../customers/schemas.js';
import { CustomersService } from '../customers/service.js';
import {
  activeItems,
  itemView,
  orderAmount,
  orderSummaryView,
  orderView,
  type Order,
  type OrderItem,
  type OrderStatus,
} from './order.js';
import type { ItemInput, OrderCreateInput } from './schemas.js';

const ORDER_EVENTS: Record<Exclude<OrderStatus, 'pending'>, EventType> = {
  paid: 'order.paid',
  failed: 'order.payment_failed',
  canceled: 'order.canceled',
};

/**
 * Order status from its charges (docs/pagarme/guides/multimeios.md): all paid -> paid, all failed -> failed,
 * all canceled -> canceled; otherwise it does not change.
 */
function statusFromCharges(statuses: ChargeStatus[]): Exclude<OrderStatus, 'pending'> | undefined {
  if (statuses.length === 0) return undefined;
  if (statuses.every((status) => status === 'paid' || status === 'overpaid')) return 'paid';
  if (statuses.every((status) => status === 'failed')) return 'failed';
  if (statuses.every((status) => status === 'canceled')) return 'canceled';
  return undefined;
}

export interface ChargeCreateInput {
  order_id: string;
  amount: number;
  payment: PaymentInput;
  customer_id?: string;
  customer?: CustomerInput;
  metadata?: Record<string, string>;
}

export interface OrderFilters {
  code?: string;
  status?: string;
  customer_id?: string;
  created_since?: string;
  created_until?: string;
}

type StoredOrder = Order & { closed_manually?: boolean };

export class OrdersService {
  private readonly orders: Repository<StoredOrder>;
  private readonly customers: CustomersService;

  constructor(private readonly ctx: AppContext) {
    this.orders = ctx.store.repository<StoredOrder>('orders');
    this.customers = new CustomersService(ctx);
  }

  find(id: string): Order | undefined {
    return this.orders.findById(id);
  }

  /** The docs answer 400 {"message": "Order not found."} on most order endpoints, 404 on a few. */
  get(id: string, notFoundStatus: 400 | 404 = 400): StoredOrder {
    const order = this.orders.findById(id);
    if (!order)
      throw notFoundStatus === 400 ? new BadRequestError('Order not found.') : new NotFoundError('Order');
    return order;
  }

  /**
   * POST /orders. Everything is validated before any card is charged. `baseUrl` is the public URL of the
   * simulator, used in the Pix QR Code and boleto links.
   */
  create(input: OrderCreateInput, body: unknown, baseUrl: string) {
    const payments = input.payments ?? [];
    if (payments.length > 1) {
      const errors: FieldErrors = {};
      payments.forEach((payment, index) => {
        if (payment.amount === undefined)
          errors[`order.payments[${index}].amount`] = ['The amount field is required.'];
      });
      if (Object.keys(errors).length > 0) throw new ValidationError(errors, body);
    }

    const customer =
      input.customer_id !== undefined
        ? this.customers.get(input.customer_id)
        : this.customers.create(input.customer as CustomerInput).customer;
    const charges = this.charges();
    const resolved = payments.map((payment, index) => ({
      payment,
      card: charges.resolveCard(customer.id, payment, `order.payments[${index}]`, body),
    }));

    const now = formatDate(this.ctx.clock.now());
    const closed = input.closed ?? true;
    let order: StoredOrder = this.orders.insert(
      compact({
        id: generateId('or'),
        code: input.code ?? randomCode(),
        currency: 'BRL' as const,
        closed,
        status: 'pending' as const,
        customer_id: customer.id,
        items: input.items.map((item) => this.newItem(item, now)),
        shipping: input.shipping && compact(input.shipping),
        metadata: input.metadata,
        charge_ids: [],
        created_at: now,
        updated_at: now,
        closed_at: closed ? now : undefined,
      }),
    );

    const amount = orderAmount(order);
    const created = resolved.map(({ payment, card }) =>
      charges.create({
        customerId: customer.id,
        orderId: order.id,
        code: order.code,
        amount: payment.amount ?? amount,
        payment,
        card,
        baseUrl,
      }),
    );
    const status = closed ? statusFromCharges(created.map((charge) => charge.status)) : undefined;
    order = this.orders.update({
      ...order,
      charge_ids: created.map((charge) => charge.id),
      status: status ?? 'pending',
    });

    const view = this.view(order);
    this.ctx.events.emit('order.created', view);
    for (const charge of created) charges.emitCreated(charge);
    if (status) this.ctx.events.emit(ORDER_EVENTS[status], view);
    return view;
  }

  /** POST /charges: adds a charge to an open order (docs/pagarme/reference/incluir-cobranca-no-pedido.md). */
  addCharge(input: ChargeCreateInput, body: unknown, baseUrl: string) {
    const order = this.get(input.order_id);
    if (order.closed) throw new PreconditionFailedError('This order is closed.');
    const customer =
      input.customer_id !== undefined
        ? this.customers.get(input.customer_id)
        : input.customer
          ? this.customers.create(input.customer).customer
          : this.customers.get(order.customer_id);
    const charges = this.charges();
    const card = charges.resolveCard(customer.id, input.payment, 'charge.payment', body);
    const charge = charges.create({
      customerId: customer.id,
      orderId: order.id,
      code: order.code,
      amount: input.amount,
      payment: { ...input.payment, metadata: input.metadata ?? input.payment.metadata },
      card,
      baseUrl,
    });
    this.orders.update({
      ...order,
      charge_ids: [...order.charge_ids, charge.id],
      updated_at: formatDate(this.ctx.clock.now()),
    });
    charges.emitCreated(charge);
    return charges.view(charge, true);
  }

  /** PATCH /orders/{id}/closed: the status sent is final (docs/pagarme/guides/pedidos-abertos.md). */
  close(id: string, status: Exclude<OrderStatus, 'pending'>) {
    const order = this.get(id);
    if (order.closed) throw new PreconditionFailedError('This order is already closed.');
    const now = formatDate(this.ctx.clock.now());
    const closed = this.orders.update({
      ...order,
      closed: true,
      closed_manually: true,
      status,
      closed_at: now,
      updated_at: now,
    });
    const view = this.view(closed);
    this.ctx.events.emit('order.closed', view);
    this.ctx.events.emit(ORDER_EVENTS[status], view);
    return view;
  }

  /** Called when a charge changes later on: closed orders follow their charges, unless closed by hand. */
  refreshStatus(id: string): void {
    const order = this.orders.findById(id);
    if (!order?.closed || order.closed_manually) return;
    const status = statusFromCharges(
      this.charges()
        .findByIds(order.charge_ids)
        .map((charge) => charge.status),
    );
    if (!status || status === order.status) return;
    const updated = this.orders.update({ ...order, status, updated_at: formatDate(this.ctx.clock.now()) });
    this.ctx.events.emit(ORDER_EVENTS[status], this.view(updated));
  }

  /** Newest first. */
  list(filters: OrderFilters): Order[] {
    const since = filters.created_since === undefined ? undefined : Date.parse(filters.created_since);
    const until = filters.created_until === undefined ? undefined : Date.parse(filters.created_until);
    return this.orders
      .findAll((order) => {
        const created = Date.parse(order.created_at);
        return (
          (filters.code === undefined || order.code === filters.code) &&
          (filters.status === undefined || order.status === filters.status) &&
          (filters.customer_id === undefined || order.customer_id === filters.customer_id) &&
          (since === undefined || created >= since) &&
          (until === undefined || created <= until)
        );
      })
      .reverse();
  }

  addItem(orderId: string, input: ItemInput) {
    const order = this.openOrder(orderId);
    const item = this.newItem(input, formatDate(this.ctx.clock.now()));
    const updated = this.orders.update({
      ...order,
      items: [...order.items, item],
      updated_at: item.created_at,
    });
    return this.emitItem('order_item.created', item, updated);
  }

  /** GET /orders/{id}/items/{item_id}: here the docs answer 404 for unknown orders. */
  getItem(orderId: string, itemId: string) {
    const order = this.get(orderId, 404);
    return itemView(this.findItem(order, itemId), orderSummaryView(order));
  }

  updateItem(orderId: string, itemId: string, input: Omit<ItemInput, 'code'>) {
    const order = this.openOrder(orderId);
    const now = formatDate(this.ctx.clock.now());
    const item: OrderItem = compact({
      ...this.findItem(order, itemId),
      amount: input.amount,
      description: input.description,
      quantity: input.quantity,
      category: input.category,
      updated_at: now,
    });
    const updated = this.replaceItem(order, item, now);
    return this.emitItem('order_item.updated', item, updated);
  }

  deleteItem(orderId: string, itemId: string) {
    const order = this.openOrder(orderId);
    const now = formatDate(this.ctx.clock.now());
    const item: OrderItem = {
      ...this.findItem(order, itemId),
      status: 'deleted',
      updated_at: now,
      deleted_at: now,
    };
    const updated = this.replaceItem(order, item, now);
    return this.emitItem('order_item.deleted', item, updated);
  }

  deleteAllItems(orderId: string) {
    const order = this.openOrder(orderId);
    const now = formatDate(this.ctx.clock.now());
    const removed = activeItems(order);
    const updated = this.orders.update({
      ...order,
      items: order.items.map((item) =>
        item.status === 'active'
          ? { ...item, status: 'deleted' as const, updated_at: now, deleted_at: now }
          : item,
      ),
      updated_at: now,
    });
    for (const item of removed) {
      const deleted = updated.items.find((candidate) => candidate.id === item.id);
      if (deleted) this.ctx.events.emit('order_item.deleted', itemView(deleted, orderSummaryView(updated)));
    }
    return this.view(updated);
  }

  view(order: Order) {
    const charges = this.charges();
    return orderView(order, {
      customer: this.customers.embeddedView(this.customers.get(order.customer_id)),
      charges: charges.findByIds(order.charge_ids).map((charge) => charges.view(charge)),
    });
  }

  private openOrder(id: string): StoredOrder {
    const order = this.get(id);
    if (order.closed) throw new PreconditionFailedError('This order is closed.');
    return order;
  }

  private findItem(order: Order, itemId: string): OrderItem {
    const item = order.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new NotFoundError('Item');
    return item;
  }

  private replaceItem(order: StoredOrder, item: OrderItem, now: string): StoredOrder {
    return this.orders.update({
      ...order,
      items: order.items.map((candidate) => (candidate.id === item.id ? item : candidate)),
      updated_at: now,
    });
  }

  private emitItem(event: EventType, item: OrderItem, order: Order) {
    const view = itemView(item, orderSummaryView(order));
    this.ctx.events.emit(event, view);
    return view;
  }

  private newItem(input: ItemInput, now: string): OrderItem {
    return compact({
      id: generateId('oi'),
      type: 'product' as const,
      description: input.description,
      amount: input.amount,
      quantity: input.quantity,
      code: input.code,
      category: input.category,
      status: 'active' as const,
      created_at: now,
      updated_at: now,
    });
  }

  // Resolved lazily: ChargesService also depends on this service.
  private charges(): ChargesService {
    return new ChargesService(this.ctx);
  }
}
