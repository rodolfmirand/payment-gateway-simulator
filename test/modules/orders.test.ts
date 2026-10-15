import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_PUBLIC_KEY, createHarness, type Harness } from '../helpers/app.js';
import { compareShape, officialExample } from '../helpers/contract.js';
import { officialCardRequest, officialOrderRequest } from './fixtures.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.app.close();
});

const createOrder = (body: unknown) => h.request('POST', '/core/v5/orders', body);
const getOrder = (id: string) => h.request('GET', `/core/v5/orders/${id}`);

/** Statuses of order / first charge / its last transaction. */
function statuses(order: any) {
  return [order.status, order.charges[0].status, order.charges[0].last_transaction.status];
}

function withPayment(body: ReturnType<typeof officialOrderRequest>, change: Record<string, unknown>) {
  const [payment] = body.payments;
  return { ...body, payments: [{ ...payment, credit_card: { ...payment?.credit_card, ...change } }] };
}

describe('POST /orders with the simulator success card', () => {
  it('pays the order and renders it like the official examples', async () => {
    const res = await createOrder(officialOrderRequest());

    expect(res.status).toBe(200);
    const order = res.body;
    expect(statuses(order)).toEqual(['paid', 'paid', 'captured']);
    expect(order).toMatchObject({
      amount: 2990,
      currency: 'BRL',
      closed: true,
      items: [
        {
          type: 'product',
          description: 'Chaveiro do Tesseract',
          amount: 2990,
          quantity: 1,
          status: 'active',
        },
      ],
      customer: { name: 'Tony Stark', email: 'avengerstark@ligadajustica.com.br', phones: {} },
      created_at: '2026-10-15T12:00:00Z',
      closed_at: '2026-10-15T12:00:00Z',
      checkouts: [],
    });
    expect(order.id).toMatch(/^or_[A-Za-z0-9]{16}$/);
    expect(order.code).toMatch(/^[A-Z0-9]{10}$/);

    const [charge] = order.charges;
    expect(charge).toMatchObject({
      code: order.code,
      amount: 2990,
      paid_amount: 2990,
      currency: 'BRL',
      payment_method: 'credit_card',
      paid_at: '2026-10-15T12:00:00Z',
      customer: { id: order.customer.id },
    });
    expect(charge.id).toMatch(/^ch_[A-Za-z0-9]{16}$/);
    expect(charge.last_transaction).toMatchObject({
      transaction_type: 'credit_card',
      amount: 2990,
      success: true,
      installments: 1,
      statement_descriptor: 'AVENGERS',
      acquirer_name: 'simulator',
      acquirer_message: 'Transação capturada com sucesso',
      acquirer_return_code: '00',
      operation_type: 'auth_and_capture',
      payment_type: 'PAN',
      card: {
        first_six_digits: '400000',
        last_four_digits: '0010',
        brand: 'Visa',
        exp_year: 2030,
        status: 'active',
      },
      gateway_response: { code: '200', errors: [] },
      antifraud_response: {},
      metadata: {},
    });
    expect(charge.last_transaction.id).toMatch(/^tran_[A-Za-z0-9]{16}$/);

    // The most recent official order example; it was made with a network token, hence the extra fields.
    const example = officialExample('GET', '/orders/{order_id}', '200', 'OK - Network Token');
    expect(compareShape(example, order)).toEqual([
      'missing $.charges[0].last_transaction.installment_type',
      'missing $.charges[0].last_transaction.entry_mode',
      'missing $.charges[0].last_transaction.card.network_token',
    ]);
    expect(JSON.stringify(order)).not.toContain('4000000000000010');
  });

  it('emits the events in the order a merchant receives them', async () => {
    await createOrder(officialOrderRequest());
    expect(h.takeEvents()).toEqual([
      'customer.created',
      'order.created',
      'charge.created',
      'charge.paid',
      'order.paid',
    ]);
  });

  it('stores the card in the customer wallet', async () => {
    const order = (await createOrder(officialOrderRequest())).body;
    const wallet = await h.request('GET', `/core/v5/customers/${order.customer.id as string}/cards`);
    expect(wallet.body.data).toHaveLength(1);
    expect(wallet.body.data[0].id).toBe(order.charges[0].last_transaction.card.id);
  });

  it('GET /orders/{id} returns the same order; unknown orders answer 400 like the official example', async () => {
    const order = (await createOrder(officialOrderRequest())).body;
    expect((await getOrder(order.id)).body).toEqual(order);

    const unknown = await getOrder('or_xxxxxxxxxxxxxxxx');
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual(officialExample('GET', '/orders/{order_id}', '400'));
  });
});

describe('simulator cards (guides/simulador-de-cartao-de-credito.md)', () => {
  it.each([
    ['4000000000000028', 'failure card'],
    ['4111111111111111', 'any other card'],
  ])('%s (%s) is not authorized', async (number) => {
    const order = (await createOrder(officialOrderRequest(number))).body;
    expect(statuses(order)).toEqual(['failed', 'failed', 'not_authorized']);
    expect(order.charges[0].last_transaction).toMatchObject({
      success: false,
      acquirer_message: 'Contate a central do seu cartão',
      acquirer_return_code: '05',
    });
    expect(order.charges[0].last_transaction.acquirer_auth_code).toBeUndefined();
    expect(h.takeEvents()).toEqual([
      'customer.created',
      'order.created',
      'charge.created',
      'charge.payment_failed',
      'order.payment_failed',
    ]);
    expect(h.scheduler.pending()).toEqual([]);
  });

  it('4000000000000036: processing, later captured and paid', async () => {
    const order = (await createOrder(officialOrderRequest('4000000000000036'))).body;
    expect(statuses(order)).toEqual(['pending', 'processing', 'with_error']);
    expect(h.takeEvents().slice(1)).toEqual(['order.created', 'charge.created', 'charge.processing']);

    h.clock.advance(5000);
    expect(h.scheduler.runPending()).toBe(1);

    const later = (await getOrder(order.id)).body;
    expect(statuses(later)).toEqual(['paid', 'paid', 'captured']);
    expect(later.charges[0]).toMatchObject({ paid_amount: 2990, paid_at: '2026-10-15T12:00:05Z' });
    expect(later.charges[0].last_transaction.acquirer_auth_code).toMatch(/^\d{6}$/);
    expect(h.takeEvents()).toEqual(['charge.paid', 'order.paid']);
  });

  it('4000000000000044: processing, later failed', async () => {
    const order = (await createOrder(officialOrderRequest('4000000000000044'))).body;
    expect(statuses(order)).toEqual(['pending', 'processing', 'with_error']);
    h.scheduler.runPending();
    expect(statuses((await getOrder(order.id)).body)).toEqual(['failed', 'failed', 'failed']);
    expect(h.takeEvents().slice(-2)).toEqual(['charge.payment_failed', 'order.payment_failed']);
  });

  it('4000000000000051: processing, later canceled and refunded', async () => {
    const order = (await createOrder(officialOrderRequest('4000000000000051'))).body;
    expect(statuses(order)).toEqual(['pending', 'pending', 'with_error']);
    expect(h.takeEvents().at(-1)).toBe('charge.pending');
    h.scheduler.runPending();
    const later = (await getOrder(order.id)).body;
    expect(statuses(later)).toEqual(['canceled', 'canceled', 'refunded']);
    expect(later.charges[0]).toMatchObject({ canceled_amount: 2990 });
    expect(h.takeEvents()).toEqual(['charge.refunded', 'order.canceled']);
  });

  it('4000000000000069: paid, later chargedback (the order stays paid)', async () => {
    const order = (await createOrder(officialOrderRequest('4000000000000069'))).body;
    expect(statuses(order)).toEqual(['paid', 'paid', 'captured']);
    h.takeEvents();
    h.scheduler.runPending();
    expect(statuses((await getOrder(order.id)).body)).toEqual(['paid', 'chargedback', 'chargedback']);
    expect(h.takeEvents()).toEqual(['charge.chargedback']);
  });

  it.each(['4000000000000077', '4000000000000093'])(
    '%s is paid (its behavior on cancel comes in stage 6)',
    async (number) => {
      const order = (await createOrder(officialOrderRequest(number))).body;
      expect(statuses(order)).toEqual(['paid', 'paid', 'captured']);
      expect(h.scheduler.pending()).toEqual([]);
    },
  );
});

describe('authorization without capture', () => {
  it.each([{ operation_type: 'auth_only' }, { capture: false }])(
    '%j leaves the charge authorized',
    async (change) => {
      const order = (await createOrder(withPayment(officialOrderRequest(), change))).body;
      expect(statuses(order)).toEqual(['pending', 'pending', 'authorized_pending_capture']);
      expect(order.charges[0].last_transaction).toMatchObject({
        operation_type: 'auth_only',
        success: true,
        acquirer_message: 'Transação autorizada com sucesso',
      });
      expect(h.takeEvents().slice(1)).toEqual(['order.created', 'charge.created', 'charge.pending']);
    },
  );

  it('a processing card is later authorized, not captured', async () => {
    const body = withPayment(officialOrderRequest('4000000000000036'), { operation_type: 'auth_only' });
    const order = (await createOrder(body)).body;
    h.scheduler.runPending();
    expect(statuses((await getOrder(order.id)).body)).toEqual([
      'pending',
      'pending',
      'authorized_pending_capture',
    ]);
  });
});

describe('card sources', () => {
  it('pays with a card of the wallet (card_id)', async () => {
    const customer = (await h.request('POST', '/core/v5/customers', { name: 'Tony' })).body;
    const card = (
      await h.request('POST', `/core/v5/customers/${customer.id as string}/cards`, {
        ...officialCardRequest,
        number: '4000000000000010',
      })
    ).body;
    const { customer: _, ...base } = withPayment(officialOrderRequest(), {
      card: undefined,
      card_id: card.id,
    });

    const order = (await createOrder({ ...base, customer_id: customer.id })).body;
    expect(statuses(order)).toEqual(['paid', 'paid', 'captured']);
    expect(order.charges[0].last_transaction.card.id).toBe(card.id);

    const other = (await h.request('POST', '/core/v5/customers', { name: 'Other' })).body;
    const res = await createOrder({ ...base, customer_id: other.id });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Card not found.' });
  });

  it('pays with a token (card_token), usable once', async () => {
    const token = await h.app.inject({
      method: 'POST',
      url: `/core/v5/tokens?appId=${TEST_PUBLIC_KEY}`,
      payload: {
        type: 'card',
        card: { number: '4000000000000010', holder_name: 'Tony', exp_month: 1, exp_year: 30, cvv: '123' },
      },
    });
    const body = withPayment(officialOrderRequest(), { card: undefined, card_token: token.json().id });

    const order = (await createOrder(body)).body;
    expect(statuses(order)).toEqual(['paid', 'paid', 'captured']);

    const again = await createOrder(body);
    expect(again.status).toBe(422);
    expect(again.body.errors).toEqual({
      'order.payments[0].credit_card.card_token': ['The token is invalid or expired.'],
    });
  });

  it('answers 404 like the official errors page for an unknown customer_id', async () => {
    const { customer: _, ...base } = officialOrderRequest();
    const res = await createOrder({ ...base, customer_id: 'cus_xxxxxxxxxxxxxxxx' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Customer not found.' });
  });
});

describe('validation (docs/pagarme/reference/erros-1.md)', () => {
  it.each([
    [
      'customer without name',
      () => ({ ...officialOrderRequest(), customer: { email: 'tony@avengers.com' } }),
      { 'order.customer.name': ['The name field is required.'] },
    ],
    [
      'card number failing Luhn',
      () =>
        withPayment(officialOrderRequest(), {
          card: { ...officialOrderRequest().payments[0]?.credit_card.card, number: '4000000000000011' },
        }),
      { 'order.payments[0].credit_card.card': ['The number field is not a valid card number'] },
    ],
    [
      'no items',
      () => ({ ...officialOrderRequest(), items: undefined }),
      { 'order.items': ['The items field is required'] },
    ],
    [
      'empty items',
      () => ({ ...officialOrderRequest(), items: [] }),
      { 'order.items': ['The items field is required'] },
    ],
  ])('%s', async (_case, body, errors) => {
    const res = await createOrder(body());
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('The request is invalid.');
    expect(res.body.errors).toEqual(errors);
  });

  it('requires a customer or customer_id, and payments for closed orders', async () => {
    const { customer: _, payments: __, ...rest } = officialOrderRequest();
    const res = await createOrder(rest);
    expect(res.body.errors).toEqual({
      'order.customer': ['The customer field is required.'],
      'order.payments': ['The payments field is required.'],
    });
  });

  it('requires a card source and expiration', async () => {
    const noCard = await createOrder(withPayment(officialOrderRequest(), { card: undefined }));
    expect(noCard.body.errors).toEqual({
      'order.payments[0].credit_card': ['The card_id, card_token or card field is required.'],
    });
    const expired = await createOrder(
      withPayment(officialOrderRequest(), {
        card: { ...officialOrderRequest().payments[0]?.credit_card.card, exp_year: 20 },
      }),
    );
    expect(expired.body.errors).toEqual({
      'order.payments[0].credit_card.card': ['The card expiration date is invalid.'],
    });
  });

  it('accepts only the payment methods implemented so far', async () => {
    const res = await createOrder({
      ...officialOrderRequest(),
      payments: [{ payment_method: 'cash', cash: {} }],
    });
    expect(res.body.errors).toEqual({
      'order.payments[0].payment_method': [
        "The payment_method field is invalid. Possible values are 'credit_card', 'pix' or 'boleto'.",
      ],
    });
  });
});

describe('multiple payments (guides/multimeios.md)', () => {
  function twoCards(first: string, second: string) {
    const base = officialOrderRequest();
    const payment = base.payments[0];
    const card = (number: string, amount: number) => ({
      ...payment,
      amount,
      credit_card: { ...payment?.credit_card, card: { ...payment?.credit_card.card, number } },
    });
    return { ...base, payments: [card(first, 1000), card(second, 1990)] };
  }

  it('is paid only when every charge is paid', async () => {
    const order = (await createOrder(twoCards('4000000000000010', '4000000000000010'))).body;
    expect(order.status).toBe('paid');
    expect(order.charges.map((c: { amount: number }) => c.amount)).toEqual([1000, 1990]);
  });

  it('keeps the order pending when the charges diverge', async () => {
    const order = (await createOrder(twoCards('4000000000000010', '4000000000000028'))).body;
    expect(order.status).toBe('pending');
    expect(order.charges.map((c: { status: string }) => c.status)).toEqual(['paid', 'failed']);
    expect(h.takeEvents()).not.toContain('order.paid');
  });

  it('requires the amount of each payment', async () => {
    const body = twoCards('4000000000000010', '4000000000000010');
    delete (body.payments[1] as { amount?: number }).amount;
    const res = await createOrder(body);
    expect(res.body.errors).toEqual({ 'order.payments[1].amount': ['The amount field is required.'] });
  });

  it('charges nothing when a later payment is invalid', async () => {
    const body = twoCards('4000000000000010', '4000000000000010');
    (body.payments[1] as { credit_card: Record<string, unknown> }).credit_card = {
      card_token: 'token_invalid',
    };
    const res = await createOrder(body);
    expect(res.status).toBe(422);
    expect((await h.request('GET', '/core/v5/orders')).body.paging.total).toBe(0);
  });
});

describe('shipping and metadata', () => {
  it('adds the shipping to the order and charge amounts', async () => {
    const order = (
      await createOrder({
        ...officialOrderRequest(),
        code: 'MY-ORDER-1',
        shipping: {
          amount: 2190,
          description: 'Economico',
          address: { line_1: '1, Rua A, Centro', zip_code: '01001000' },
        },
        metadata: { channel: 'app' },
      })
    ).body;
    expect(order).toMatchObject({
      code: 'MY-ORDER-1',
      amount: 5180,
      shipping: { amount: 2190, description: 'Economico' },
      metadata: { channel: 'app' },
    });
    expect(order.charges[0].amount).toBe(5180);
  });
});

describe('open orders (guides/pedidos-abertos.md)', () => {
  const openOrder = () => createOrder({ ...officialOrderRequest(), closed: false });

  it('stays pending even when paid, until closed', async () => {
    const order = (await openOrder()).body;
    expect(order).toMatchObject({ closed: false, status: 'pending' });
    expect(order.closed_at).toBeUndefined();
    expect(order.charges[0].status).toBe('paid');
    expect(h.takeEvents()).not.toContain('order.paid');

    h.clock.advance(1000);
    const closed = await h.request('PATCH', `/core/v5/orders/${order.id as string}/closed`, {
      status: 'paid',
    });
    expect(closed.status).toBe(200);
    expect(compareShape(officialExample('PATCH', '/orders/{order_id}/closed', '200'), closed.body)).toEqual([
      'missing $.customer.metadata', // the customer of the example has metadata, ours does not
    ]);
    expect(closed.body).toMatchObject({ closed: true, status: 'paid', closed_at: '2026-10-15T12:00:01Z' });
    expect(h.takeEvents()).toEqual(['order.closed', 'order.paid']);

    const again = await h.request('PATCH', `/core/v5/orders/${order.id as string}/closed`, {
      status: 'paid',
    });
    expect(again.status).toBe(412);
  });

  it('can be created without payments; closing validates the status', async () => {
    const { payments: _, ...rest } = officialOrderRequest();
    const order = (await createOrder({ ...rest, closed: false })).body;
    expect(order.charges).toEqual([]);
    const invalid = await h.request('PATCH', `/core/v5/orders/${order.id as string}/closed`, {
      status: 'pending',
    });
    expect(invalid.body.errors).toEqual({
      'order.status': ["The status field is invalid. Possible values are 'paid', 'canceled' or 'failed'."],
    });
  });

  it('keeps the status chosen on close even if a charge changes later', async () => {
    const order = (await createOrder({ ...officialOrderRequest('4000000000000036'), closed: false })).body;
    await h.request('PATCH', `/core/v5/orders/${order.id as string}/closed`, { status: 'canceled' });
    h.scheduler.runPending();
    const later = (await getOrder(order.id)).body;
    expect(later.status).toBe('canceled');
    expect(later.charges[0].status).toBe('paid');
  });

  it('POST /charges adds a charge to an open order', async () => {
    const { payments, ...rest } = officialOrderRequest();
    const order = (await createOrder({ ...rest, closed: false })).body;
    h.takeEvents();

    const res = await h.request('POST', '/core/v5/charges', {
      order_id: order.id,
      amount: 2990,
      payment: payments[0],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      amount: 2990,
      status: 'paid',
      code: order.code,
      order: { id: order.id, status: 'pending', closed: false },
      customer: { id: order.customer.id },
    });
    // The example is from 2017: due_at only exists on boleto, and funding_source, acquirer_affiliation_code
    // and credit_card (now "card") are gone from the 2023 examples.
    expect(compareShape(officialExample('POST', '/charges', '200'), res.body)).toEqual([
      'missing $.due_at',
      'missing $.last_transaction.funding_source',
      'missing $.last_transaction.acquirer_affiliation_code',
      'missing $.last_transaction.credit_card',
    ]);
    expect(h.takeEvents()).toEqual(['charge.created', 'charge.paid']);
    expect((await getOrder(order.id)).body.charges).toHaveLength(1);
  });

  it('POST /charges refuses closed and unknown orders', async () => {
    const order = (await createOrder(officialOrderRequest())).body;
    const payment = officialOrderRequest().payments[0];
    const closed = await h.request('POST', '/core/v5/charges', { order_id: order.id, amount: 100, payment });
    expect(closed.status).toBe(412);
    const unknown = await h.request('POST', '/core/v5/charges', {
      order_id: 'or_xxxxxxxxxxxxxxxx',
      amount: 100,
      payment,
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ message: 'Order not found.' });
  });
});

describe('order items', () => {
  it('adds, gets, edits and deletes items of an open order', async () => {
    const order = (await createOrder({ ...officialOrderRequest(), closed: false })).body;
    const base = `/core/v5/orders/${order.id as string}/items`;
    h.takeEvents();

    const added = await h.request('POST', base, {
      amount: 1090,
      description: 'Caneca Zero Grau',
      quantity: 2,
      code: 'CANECA',
    });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({
      description: 'Caneca Zero Grau',
      amount: 1090,
      quantity: 2,
      code: 'CANECA',
      status: 'active',
      order: { id: order.id, amount: 2990 + 2180 },
    });
    expect(added.body.id).toMatch(/^oi_[A-Za-z0-9]{16}$/);
    const example = officialExample('POST', '/orders/{order_id}/items', '200') as Record<string, unknown>;
    expect(compareShape({ ...example, seller: undefined }, added.body)).toEqual(['missing $.seller']);

    const fetched = await h.request('GET', `${base}/${added.body.id as string}`);
    expect(fetched.body).toEqual(added.body);

    const edited = await h.request('PUT', `${base}/${added.body.id as string}`, {
      amount: 1090,
      description: 'Água com gás',
      quantity: 1,
    });
    expect(
      compareShape(officialExample('PUT', '/orders/{order_id}/items/{item_id}', '200'), edited.body),
    ).toEqual([]);
    expect(edited.body).toMatchObject({
      description: 'Água com gás',
      quantity: 1,
      code: 'CANECA',
      order: { amount: 4080 },
    });

    const deleted = await h.request('DELETE', `${base}/${added.body.id as string}`);
    expect(deleted.body).toMatchObject({
      status: 'deleted',
      deleted_at: '2026-10-15T12:00:00Z',
      order: { amount: 2990 },
    });
    expect((await getOrder(order.id)).body.items).toHaveLength(1);

    const cleared = await h.request('DELETE', base);
    expect(cleared.body).toMatchObject({ id: order.id, items: [], amount: 0 });
    expect(h.takeEvents()).toEqual([
      'order_item.created',
      'order_item.updated',
      'order_item.deleted',
      'order_item.deleted',
    ]);
  });

  it('refuses changes to closed orders and answers 404 for unknown items', async () => {
    const order = (await createOrder(officialOrderRequest())).body;
    const base = `/core/v5/orders/${order.id as string}/items`;
    const closed = await h.request('POST', base, { amount: 100, description: 'x', quantity: 1 });
    expect(closed.status).toBe(412);
    expect(closed.body).toEqual({ message: 'This order is closed.' });

    const unknownItem = await h.request('GET', `${base}/oi_xxxxxxxxxxxxxxxx`);
    expect(unknownItem.status).toBe(404);
    expect(unknownItem.body).toEqual({ message: 'Item not found.' });

    const unknownOrder = await h.request(
      'GET',
      '/core/v5/orders/or_xxxxxxxxxxxxxxxx/items/oi_xxxxxxxxxxxxxxxx',
    );
    expect(unknownOrder.status).toBe(404);
    expect(unknownOrder.body).toEqual(officialExample('GET', '/orders/{order_id}/items/{item_id}', '404'));
  });
});

describe('GET /orders', () => {
  it('lists newest first with filters and at most 30 per page', async () => {
    const first = (await createOrder({ ...officialOrderRequest(), code: 'A' })).body;
    h.clock.advance(60_000);
    const second = (await createOrder({ ...officialOrderRequest('4000000000000028'), code: 'B' })).body;

    const all = await h.request('GET', '/core/v5/orders');
    expect(all.body.data.map((o: { id: string }) => o.id)).toEqual([second.id, first.id]);
    // data[0] is the failed order (no paid_at) and two orders fit in one page (no "next").
    expect(compareShape(officialExample('GET', '/orders', '200'), all.body)).toEqual([
      'missing $.data[0].charges[0].paid_at',
      'missing $.paging.next',
    ]);

    const query = async (q: string) =>
      (await h.request('GET', `/core/v5/orders?${q}`)).body.data.map((o: { code: string }) => o.code);
    expect(await query('status=failed')).toEqual(['B']);
    expect(await query('code=A')).toEqual(['A']);
    expect(await query(`customer_id=${first.customer.id as string}`)).toEqual(['B', 'A']);
    expect(await query('created_since=2026-10-15T12:00:30Z')).toEqual(['B']);
    expect(await query('created_until=2026-10-15T12:00:30Z')).toEqual(['A']);
    expect((await h.request('GET', '/core/v5/orders?size=100')).body.paging).toEqual({ total: 2 });
  });
});
