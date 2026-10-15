import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { compareShape, officialFixture } from '../helpers/contract.js';
import { officialOrderRequest } from './fixtures.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.app.close();
});

const createOrder = (body: unknown) => h.request('POST', '/core/v5/orders', body);
const getOrder = async (id: string) => (await h.request('GET', `/core/v5/orders/${id}`)).body;
const statuses = (order: any) => [
  order.status,
  order.charges[0].status,
  order.charges[0].last_transaction.status,
];

function pixRequest(amount = 2990, pix: Record<string, unknown> = {}) {
  const request = structuredClone(officialFixture('pix-order-request'));
  request.items[0].amount = amount;
  request.payments[0].pix = { ...request.payments[0].pix, ...pix };
  return request;
}

function boletoRequest(zipCode = '20021130', boleto: Record<string, unknown> = {}) {
  const request = structuredClone(officialFixture('boleto-order-request'));
  request.customer.address.zip_code = zipCode;
  request.payments[0].boleto = { ...request.payments[0].boleto, ...boleto };
  return request;
}

/** CRC16-CCITT of a Pix BR Code, to check the last 4 characters. */
function crc16(payload: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(payload)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

describe('Pix (reference/pix-2.md, guides/simulador-pix.md)', () => {
  it('creates a pending charge with QR Code, shaped like the official example', async () => {
    const res = await createOrder(pixRequest());

    expect(res.status).toBe(200);
    const order = res.body;
    expect(statuses(order)).toEqual(['pending', 'pending', 'waiting_payment']);
    const [charge] = order.charges;
    expect(charge.payment_method).toBe('pix');
    const transaction = charge.last_transaction;
    expect(transaction).toMatchObject({
      transaction_type: 'pix',
      amount: 2990,
      success: true,
      expires_at: new Date(Date.parse('2026-10-15T12:00:00Z') + 52134613 * 1000)
        .toISOString()
        .replace('.000', ''),
      additional_information: [{ name: 'Quantidade', value: '2' }],
      gateway_response: {},
      antifraud_response: {},
    });
    expect(transaction.qr_code_url).toBe(
      `http://localhost/core/v5/transactions/${transaction.id as string}/qrcode?payment_method=pix`,
    );
    expect(transaction.qr_code).toMatch(/^000201/);
    expect(transaction.qr_code.slice(-4)).toBe(crc16(transaction.qr_code.slice(0, -4)));
    expect(transaction.qr_code).toContain('br.gov.bcb.pix');
    expect(transaction.qr_code).toContain('540529.90');

    // The 2019 example still had "Pix" capitalized, plus shipping and device fields that this request has not.
    expect(compareShape(officialFixture('pix-order'), order)).toEqual([
      'missing $.shipping',
      'missing $.ip',
      'missing $.session_id',
      'missing $.device',
      'missing $.location',
    ]);
  });

  it('is paid automatically a few seconds later (up to R$ 500,00)', async () => {
    const order = (await createOrder(pixRequest(50_000))).body;
    expect(h.takeEvents()).toEqual(['customer.created', 'order.created', 'charge.created', 'charge.pending']);

    h.clock.advance(5000);
    expect(h.scheduler.runPending()).toBe(1);

    const paid = await getOrder(order.id);
    expect(statuses(paid)).toEqual(['paid', 'paid', 'paid']);
    expect(paid.charges[0]).toMatchObject({ paid_amount: 50_000, paid_at: '2026-10-15T12:00:05Z' });
    expect(paid.charges[0].last_transaction).toMatchObject({
      end_to_end_id: expect.stringMatching(/^E\d{8}\d{12}\d{11}$/),
      payer: {
        name: 'Tony Stark',
        document_type: 'CPF',
        document: '***.345.678-**',
        bank_account: { bank_name: 'Pagarme', ispb: '18236120' },
      },
    });
    expect(h.takeEvents()).toEqual(['charge.paid', 'order.paid']);
  });

  it('fails above R$ 500,00', async () => {
    const order = (await createOrder(pixRequest(50_001))).body;
    expect(statuses(order)).toEqual(['failed', 'failed', 'failed']);
    expect(order.charges[0].last_transaction.success).toBe(false);
    expect(h.takeEvents().slice(-2)).toEqual(['charge.payment_failed', 'order.payment_failed']);
    expect(h.scheduler.pending()).toEqual([]);
  });

  it('accepts expires_at, "Pix" capitalized, and requires an expiration', async () => {
    const request = pixRequest(2990, { expires_in: undefined, expires_at: '2026-10-16T12:00:00Z' });
    request.payments[0].payment_method = 'Pix';
    const order = (await createOrder(request)).body;
    expect(order.charges[0].last_transaction.expires_at).toBe('2026-10-16T12:00:00Z');

    const invalid = await createOrder(pixRequest(2990, { expires_in: undefined }));
    expect(invalid.status).toBe(422);
    expect(invalid.body.errors).toEqual({
      'order.payments[0].pix.expires_in': ['The expires_in field is required.'],
    });
  });

  it('serves the QR Code image without authentication', async () => {
    const order = (await createOrder(pixRequest())).body;
    const url = new URL(order.charges[0].last_transaction.qr_code_url as string);
    const raw = await h.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` }); // no Authorization
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toBe('image/png');
    expect(raw.rawPayload.subarray(1, 4).toString()).toBe('PNG');

    const unknown = await h.app.inject({
      method: 'GET',
      url: '/core/v5/transactions/tran_xxxxxxxxxxxxxxxx/qrcode',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ message: 'Transaction not found.' });
  });
});

describe('boleto (reference/boleto-1.md, guides/simulador-de-boleto.md)', () => {
  it('generates the boleto like the official example', async () => {
    const res = await createOrder(boletoRequest());

    expect(res.status).toBe(200);
    const order = res.body;
    expect(statuses(order)).toEqual(['pending', 'pending', 'generated']);
    expect(order.customer.type).toBe('individual');
    const [charge] = order.charges;
    expect(charge).toMatchObject({ payment_method: 'boleto', due_at: '2022-09-20T00:00:00Z' });
    const transaction = charge.last_transaction;
    const files = `http://localhost/core/v5/transactions/${transaction.id as string}`;
    expect(transaction).toMatchObject({
      transaction_type: 'boleto',
      status: 'generated',
      success: true,
      url: `${files}/boleto`,
      pdf: `${files}/pdf`,
      barcode: `${files}/barcode`,
      qr_code: `${files}/qrcode`,
      type: 'DM',
      document_number: '123',
      instructions: 'Pagar até o vencimento',
      due_at: '2022-09-20T00:00:00Z',
      gateway_response: { code: '201' },
    });
    expect(transaction.nosso_numero).toMatch(/^\d{8}$/);
    // bank 341, currency 9; due factor and amount (R$ 29,90 + R$ 1,00 of shipping) in the last 14 digits
    expect(transaction.line).toMatch(/^3419\d\.\d{5} \d{5}\.\d{6} \d{5}\.\d{6} \d \d{4}0000003090$/);
    expect(transaction.line.slice(-14, -10)).toBe('9114'); // days from 1997-10-07 to the due date 2022-09-20

    // ip, session_id, device and location come from antifraud data this request does not send.
    expect(compareShape(officialFixture('boleto-order'), order)).toEqual([
      'missing $.ip',
      'missing $.session_id',
      'missing $.device',
      'missing $.location',
    ]);
  });

  it('is due in 3 days when due_at is not sent', async () => {
    const order = (await createOrder(boletoRequest('20021130', { due_at: undefined }))).body;
    expect(order.charges[0].due_at).toBe('2026-10-18T00:00:00Z');
  });

  it.each([
    ['20021130', 'paid', 3090, 'charge.paid', 'paid', ['order.paid']],
    ['01046010', 'underpaid', 2781, 'charge.underpaid', 'pending', []],
    ['57400000', 'overpaid', 3399, 'charge.overpaid', 'paid', ['order.paid']],
  ])('CEP %s: conciliated as %s', async (zip, status, paidAmount, chargeEvent, orderStatus, orderEvents) => {
    const order = (await createOrder(boletoRequest(zip))).body;
    h.takeEvents();
    expect(h.scheduler.runPending()).toBe(1);

    const later = await getOrder(order.id);
    expect(statuses(later)).toEqual([orderStatus, status, status]);
    expect(later.charges[0]).toMatchObject({ paid_amount: paidAmount });
    expect(later.charges[0].last_transaction).toMatchObject({ paid_amount: paidAmount });
    expect(h.takeEvents()).toEqual([chargeEvent, ...orderEvents]);
  });

  it('CEP 70070300: never conciliated', async () => {
    const order = (await createOrder(boletoRequest('70070300'))).body;
    expect(h.scheduler.pending()).toEqual([]);
    expect(statuses(await getOrder(order.id))).toEqual(['pending', 'pending', 'generated']);
  });

  it('serves the PDF, the barcode, the QR Code and the boleto page without authentication', async () => {
    const order = (await createOrder(boletoRequest())).body;
    const transaction = order.charges[0].last_transaction;
    const get = (url: string) => h.app.inject({ method: 'GET', url: new URL(url).pathname });

    const pdf = await get(transaction.pdf as string);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(pdf.rawPayload.toString('latin1')).toContain(transaction.line as string);

    for (const url of [transaction.barcode, transaction.qr_code] as string[]) {
      const image = await get(url);
      expect(image.headers['content-type']).toBe('image/png');
    }

    const page = await get(transaction.url as string);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body).toContain(transaction.line as string);
    expect(page.body).toContain('R$ 30,90'); // R$ 29,90 + R$ 1,00 of shipping
  });
});

describe('credit card + boleto in one order (guides/multimeios.md)', () => {
  it('is paid once the boleto is paid', async () => {
    const card = officialOrderRequest().payments[0];
    const boleto = boletoRequest();
    const order = (
      await createOrder({
        ...boleto,
        items: [{ amount: 100_000, description: 'TV', quantity: 1 }],
        payments: [
          { ...card, amount: 90_000 },
          { ...boleto.payments[0], amount: 10_000 },
        ],
      })
    ).body;
    expect(order.status).toBe('pending');
    expect(order.charges.map((charge: { status: string }) => charge.status)).toEqual(['paid', 'pending']);

    h.scheduler.runPending();
    expect((await getOrder(order.id)).status).toBe('paid');
  });
});

describe('the official credit card example', () => {
  it('has the shape of "Response Crédito (Basico)"', async () => {
    const order = (await createOrder(officialOrderRequest())).body;
    expect(compareShape(officialFixture('credit-card-order'), order)).toEqual([
      'missing $.charges[0].funding_source',
      'missing $.charges[0].last_transaction.funding_source',
    ]);
  });
});
