import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { compareShape, officialExample, officialFixture } from '../helpers/contract.js';
import { officialOrderRequest } from './fixtures.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.app.close();
});

/** Creates an order and returns its first charge; events of the creation are discarded. */
async function charge(body: unknown) {
  const order = (await h.request('POST', '/core/v5/orders', body)).body;
  h.takeEvents();
  return order.charges[0];
}

const cardOrder = (number = '4000000000000010', creditCard: Record<string, unknown> = {}) => {
  const body = officialOrderRequest(number);
  const [payment] = body.payments;
  return { ...body, payments: [{ ...payment, credit_card: { ...payment?.credit_card, ...creditCard } }] };
};

function boletoOrder(zip = '20021130') {
  const request = structuredClone(officialFixture('boleto-order-request'));
  request.customer.address.zip_code = zip;
  return request;
}

function pixOrder(amount = 2990) {
  const request = structuredClone(officialFixture('pix-order-request'));
  request.items[0].amount = amount;
  return request;
}

const get = async (id: string) => (await h.request('GET', `/core/v5/charges/${id}`)).body;
const capture = (id: string, body?: unknown) => h.request('POST', `/core/v5/charges/${id}/capture`, body);
const cancel = (id: string, body?: unknown) => h.request('DELETE', `/core/v5/charges/${id}`, body);
const transactionStatuses = (c: any) => [
  c.status,
  c.last_transaction.status,
  c.last_transaction.operation_type,
];

describe('GET /charges', () => {
  it('gets a charge with its order summary', async () => {
    const created = await charge(cardOrder());
    const res = await h.request('GET', `/core/v5/charges/${created.id as string}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: created.id,
      status: 'paid',
      order: { status: 'paid', closed: true },
    });
    // The 2019 example still had funding_source, and was created with metadata.
    expect(compareShape(officialExample('GET', '/charges/{charge_id}', '200'), res.body)).toEqual([
      'missing $.last_transaction.funding_source',
      'missing $.metadata',
    ]);

    const unknown = await h.request('GET', '/core/v5/charges/ch_xxxxxxxxxxxxxxxx');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ message: 'Charge not found.' });
  });

  it('lists newest first with the filters of the docs', async () => {
    const card = await charge(cardOrder());
    h.clock.advance(60_000);
    const boleto = await charge(boletoOrder());

    const query = async (q = '') =>
      (await h.request('GET', `/core/v5/charges?${q}`)).body.data.map((c: { id: string }) => c.id);
    expect(await query()).toEqual([boleto.id, card.id]);
    expect(await query('payment_method=boleto')).toEqual([boleto.id]);
    expect(await query('status=paid')).toEqual([card.id]);
    expect(await query(`order_id=${(await get(card.id)).order.id as string}`)).toEqual([card.id]);
    expect(await query(`code=${card.code as string}`)).toEqual([card.id]);
    expect(await query('created_since=2026-10-15T12:00:30Z')).toEqual([boleto.id]);
    // Both orders use the same e-mail, so they belong to the same customer (the e-mail is a unique key).
    expect(await query(`customer_id=${card.customer.id as string}`)).toEqual([boleto.id, card.id]);
  });
});

describe('POST /charges/{id}/capture', () => {
  it('captures an authorized charge with a new "capture" transaction', async () => {
    const authorized = await charge(cardOrder('4000000000000010', { operation_type: 'auth_only' }));
    expect(transactionStatuses(authorized)).toEqual(['pending', 'authorized_pending_capture', 'auth_only']);

    h.clock.advance(1000);
    const res = await capture(authorized.id);
    expect(res.status).toBe(200);
    expect(transactionStatuses(res.body)).toEqual(['paid', 'captured', 'capture']);
    expect(res.body).toMatchObject({
      paid_amount: 2990,
      paid_at: '2026-10-15T12:00:01Z',
      order: { status: 'paid' },
    });
    expect(res.body.last_transaction.id).not.toBe(authorized.last_transaction.id);
    expect(res.body.last_transaction.card.id).toBe(authorized.last_transaction.card.id);
    expect(h.takeEvents()).toEqual(['charge.paid', 'order.paid']);
  });

  it('captures part of the amount', async () => {
    const authorized = await charge(cardOrder('4000000000000010', { operation_type: 'auth_only' }));
    const res = await capture(authorized.id, { amount: 1000 });
    expect(transactionStatuses(res.body)).toEqual(['paid', 'partial_capture', 'capture']);
    expect(res.body).toMatchObject({ amount: 2990, paid_amount: 1000, last_transaction: { amount: 1000 } });
  });

  it('refuses amounts above the authorized one and charges that are not authorized', async () => {
    const authorized = await charge(cardOrder('4000000000000010', { operation_type: 'auth_only' }));
    const tooMuch = await capture(authorized.id, { amount: 3000 });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.errors).toEqual({
      'charge.amount': ['The field amount must be less than or equal to 2990'],
    });

    const paid = await charge(cardOrder());
    const res = await capture(paid.id);
    expect(res.status).toBe(412);
    expect(res.body).toEqual({ message: 'This charge can not be captured.' });
  });
});

describe('DELETE /charges/{id}: credit card', () => {
  it('refunds a captured charge like the official example', async () => {
    const paid = await charge(cardOrder());
    h.clock.advance(1000);
    const res = await cancel(paid.id);

    expect(res.status).toBe(200);
    expect(transactionStatuses(res.body)).toEqual(['canceled', 'refunded', 'cancel']);
    expect(res.body).toMatchObject({
      paid_amount: 2990,
      canceled_amount: 2990,
      canceled_at: '2026-10-15T12:00:01Z',
      order: { status: 'canceled' },
      last_transaction: { amount: 2990, success: true },
    });
    const example = officialExample('DELETE', '/charges/{charge_id}', '200', 'Estorno de cartão de crédito');
    expect(compareShape(example, res.body)).toEqual([
      'missing $.last_transaction.funding_source',
      'missing $.metadata',
    ]);
    expect(res.body.last_transaction.acquirer_auth_code).toBe(paid.last_transaction.acquirer_auth_code);
    expect(h.takeEvents()).toEqual(['charge.refunded', 'order.canceled']);
  });

  it('refunds in parts until the whole amount is refunded', async () => {
    const paid = await charge(cardOrder());

    const first = await cancel(paid.id, { amount: 1000 });
    expect(transactionStatuses(first.body)).toEqual(['paid', 'partial_refunded', 'cancel']);
    expect(first.body).toMatchObject({ canceled_amount: 1000, last_transaction: { amount: 1000 } });
    expect(first.body.canceled_at).toBeUndefined();
    expect(h.takeEvents()).toEqual(['charge.partial_canceled']);

    const tooMuch = await cancel(paid.id, { amount: 2000 });
    expect(tooMuch.body.errors).toEqual({
      'charge.amount': ['The field amount must be less than or equal to 1990'],
    });

    const second = await cancel(paid.id, { amount: 1990 });
    expect(transactionStatuses(second.body)).toEqual(['canceled', 'refunded', 'cancel']);
    expect(second.body.canceled_amount).toBe(2990);
    expect(h.takeEvents()).toEqual(['charge.refunded', 'order.canceled']);
  });

  it('voids an authorization that was not captured', async () => {
    const authorized = await charge(cardOrder('4000000000000010', { operation_type: 'auth_only' }));
    const partial = await cancel(authorized.id, { amount: 990 });
    expect(transactionStatuses(partial.body)).toEqual(['pending', 'partial_void', 'cancel']);

    const authorizedAgain = await charge(cardOrder('4000000000000010', { operation_type: 'auth_only' }));
    const full = await cancel(authorizedAgain.id);
    expect(transactionStatuses(full.body)).toEqual(['canceled', 'voided', 'cancel']);
  });

  it('refuses charges that cannot be canceled', async () => {
    const failed = await charge(cardOrder('4000000000000028'));
    const res = await cancel(failed.id);
    expect(res.status).toBe(412);
    expect(res.body).toEqual({ message: 'This charge can not be canceled.' });

    const paid = await charge(cardOrder());
    await cancel(paid.id);
    expect((await cancel(paid.id)).status).toBe(412);
  });

  it('4000000000000077: the cancellation is processing, then canceled and refunded', async () => {
    const paid = await charge(cardOrder('4000000000000077'));
    const res = await cancel(paid.id);
    expect(transactionStatuses(res.body)).toEqual(['processing', 'with_error', 'cancel']);
    expect(res.body.order.status).toBe('processing');
    expect(h.takeEvents()).toEqual(['charge.processing']);

    h.scheduler.runPending();
    const later = await get(paid.id);
    expect(transactionStatuses(later)).toEqual(['canceled', 'refunded', 'cancel']);
    expect(later).toMatchObject({ canceled_amount: 2990, order: { status: 'canceled' } });
    expect(h.takeEvents()).toEqual(['charge.refunded', 'order.canceled']);
  });

  it('4000000000000093: the cancellation is processing, then the charge is paid again', async () => {
    const paid = await charge(cardOrder('4000000000000093'));
    const res = await cancel(paid.id);
    expect(transactionStatuses(res.body)).toEqual(['processing', 'with_error', 'cancel']);
    expect(res.body.order.status).toBe('processing');

    h.scheduler.runPending();
    const later = await get(paid.id);
    expect(transactionStatuses(later)).toEqual(['paid', 'captured', 'cancel']);
    expect(later.order.status).toBe('paid');
    expect(later.canceled_amount).toBeUndefined();
    expect(h.takeEvents()).toEqual(['charge.processing', 'charge.paid', 'order.paid']);
  });
});

describe('DELETE /charges/{id}: Pix and boleto', () => {
  it('cancels a Pix not paid yet; the automatic payment no longer happens', async () => {
    const pix = await charge(pixOrder());
    const res = await cancel(pix.id);
    expect(res.body).toMatchObject({ status: 'canceled', last_transaction: { status: 'voided' } });
    h.scheduler.runPending();
    expect((await get(pix.id)).status).toBe('canceled');
  });

  it('refunds a paid Pix, also in parts', async () => {
    const pix = await charge(pixOrder());
    h.scheduler.runPending();
    h.takeEvents();

    const first = await cancel(pix.id, { amount: 990 });
    expect(first.body).toMatchObject({
      status: 'paid',
      canceled_amount: 990,
      last_transaction: { status: 'partial_refunded' },
    });
    const second = await cancel(pix.id);
    expect(second.body).toMatchObject({
      status: 'canceled',
      canceled_amount: 2990,
      last_transaction: { status: 'refunded' },
    });
    expect(h.takeEvents()).toEqual(['charge.partial_canceled', 'charge.refunded', 'order.canceled']);
  });

  it('writes off an unpaid boleto: it is never conciliated', async () => {
    const boleto = await charge(boletoOrder());
    const res = await cancel(boleto.id);
    expect(res.body).toMatchObject({ status: 'canceled', last_transaction: { status: 'voided' } });
    h.scheduler.runPending();
    expect((await get(boleto.id)).status).toBe('canceled');
  });

  it('cancels a paid boleto without refunding it (rule in force since 2026-10-01)', async () => {
    const boleto = await charge(boletoOrder());
    h.scheduler.runPending();
    const res = await cancel(boleto.id);
    expect(res.body).toMatchObject({
      status: 'canceled',
      paid_amount: 3090,
      canceled_amount: 3090,
      last_transaction: { status: 'paid' },
    });
  });
});

describe('POST /charges/{id}/retry', () => {
  it('authorizes a failed charge again with the same card', async () => {
    const failed = await charge(cardOrder('4000000000000028'));
    const res = await h.request('POST', `/core/v5/charges/${failed.id as string}/retry`);
    expect(res.status).toBe(200);
    expect(transactionStatuses(res.body)).toEqual(['failed', 'not_authorized', 'auth_and_capture']);
    expect(res.body.last_transaction.id).not.toBe(failed.last_transaction.id);
    // The example is from 2017 (credit_card instead of card, acquirer_affiliation_code...).
    expect(compareShape(officialExample('POST', '/charges/{charge_id}/retry', '200'), res.body)).toEqual([
      'missing $.due_at',
      'missing $.last_transaction.funding_source',
      'missing $.last_transaction.acquirer_affiliation_code',
      'missing $.last_transaction.acquirer_auth_code',
      'missing $.last_transaction.credit_card',
      'missing $.metadata',
    ]);
    expect(h.takeEvents()).toEqual(['charge.payment_failed']);
  });

  it('refuses charges that did not fail', async () => {
    const paid = await charge(cardOrder());
    const res = await h.request('POST', `/core/v5/charges/${paid.id as string}/retry`);
    expect(res.status).toBe(412);
  });
});

describe('PATCH /charges/{id}/card', () => {
  it('pays a not authorized charge with another card', async () => {
    const failed = await charge(cardOrder('4000000000000028'));
    const newCard = { ...officialOrderRequest().payments[0]?.credit_card.card, number: '4000000000000010' };
    const res = await h.request('PATCH', `/core/v5/charges/${failed.id as string}/card`, { card: newCard });

    expect(res.status).toBe(200);
    expect(transactionStatuses(res.body)).toEqual(['paid', 'captured', 'auth_and_capture']);
    expect(res.body.last_transaction.card.last_four_digits).toBe('0010');
    expect(res.body.order.status).toBe('paid');
    expect(compareShape(officialExample('PATCH', '/charges/{charge_id}/card', '200'), res.body)).toEqual([
      'missing $.last_transaction.funding_source',
      'missing $.metadata',
    ]);
    expect(h.takeEvents()).toEqual(['charge.paid', 'order.paid']);
  });

  it('answers 412 like the official example when the transaction was authorized', async () => {
    const paid = await charge(cardOrder());
    const res = await h.request('PATCH', `/core/v5/charges/${paid.id as string}/card`, { card_id: 'card_x' });
    expect(res.status).toBe(412);
    expect(res.body).toEqual(officialExample('PATCH', '/charges/{charge_id}/card', '412'));
  });
});

describe('PATCH /charges/{id}/payment-method', () => {
  it('turns a failed card charge into a boleto', async () => {
    const failed = await charge(cardOrder('4000000000000028'));
    const res = await h.request('PATCH', `/core/v5/charges/${failed.id as string}/payment-method`, {
      payment_method: 'boleto',
      boleto: { instructions: 'Pagar até o vencimento', due_at: '2026-10-20T00:00:00Z' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'pending',
      payment_method: 'boleto',
      due_at: '2026-10-20T00:00:00Z',
      last_transaction: { transaction_type: 'boleto', status: 'generated' },
    });
    expect(h.takeEvents()).toEqual(['charge.pending']);

    h.scheduler.runPending();
    expect((await get(failed.id)).status).toBe('paid');
  });

  it('answers 412 like the official example for paid charges', async () => {
    const paid = await charge(cardOrder());
    const res = await h.request('PATCH', `/core/v5/charges/${paid.id as string}/payment-method`, {
      payment_method: 'pix',
      pix: { expires_in: 3600 },
    });
    expect(res.status).toBe(412);
    expect(res.body).toEqual(officialExample('PATCH', '/charges/{charge_id}/payment-method', '412'));
  });
});

describe('PATCH /charges/{id}/due-date', () => {
  it('changes the due date of a boleto, including the digitable line', async () => {
    const boleto = await charge(boletoOrder('70070300'));
    const res = await h.request('PATCH', `/core/v5/charges/${boleto.id as string}/due-date`, {
      due_at: '2026-11-30T00:00:00Z',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      due_at: '2026-11-30T00:00:00Z',
      last_transaction: { due_at: '2026-11-30T00:00:00Z' },
    });
    expect(res.body.last_transaction.line.slice(-14, -10)).toBe('1646'); // FEBRABAN factor: 1000 on 2025-02-22 + 646 days
    // The example boleto was created with bank and metadata, which this request does not send.
    expect(compareShape(officialExample('PATCH', '/charges/{charge_id}/due-date', '200'), res.body)).toEqual([
      'missing $.last_transaction.bank',
      'missing $.metadata',
    ]);
  });

  it('refuses charges that are not unpaid boletos', async () => {
    const card = await charge(cardOrder());
    const res = await h.request('PATCH', `/core/v5/charges/${card.id as string}/due-date`, {
      due_at: '2026-11-30T00:00:00Z',
    });
    expect(res.status).toBe(412);
  });
});
