import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_PUBLIC_KEY, createHarness, type Harness } from '../helpers/app.js';
import { compareShape, officialExample } from '../helpers/contract.js';
import { customerForEmbedding, officialAddressRequest, officialCardRequest } from './fixtures.js';

let h: Harness;
let customerId: string;
let base: string;

beforeEach(async () => {
  h = await createHarness();
  customerId = (await h.request('POST', '/core/v5/customers', customerForEmbedding)).body.id as string;
  base = `/core/v5/customers/${customerId}/cards`;
  h.emitted.length = 0;
});
afterEach(async () => {
  await h.app.close();
});

async function createToken(card: Record<string, unknown> = {}) {
  const res = await h.app.inject({
    method: 'POST',
    url: `/core/v5/tokens?appId=${TEST_PUBLIC_KEY}`,
    payload: {
      type: 'card',
      card: {
        number: '4000000000000010',
        holder_name: 'Tony Stark',
        exp_month: 1,
        exp_year: 30,
        cvv: '123',
        ...card,
      },
    },
  });
  return res.json<{ id: string }>().id;
}

describe('POST /customers/{id}/cards', () => {
  it('creates the card with the shape of the official example', async () => {
    const res = await h.request('POST', base, officialCardRequest);

    expect(res.status).toBe(200);
    expect(
      compareShape(officialExample('POST', '/customers/{customer_id}/cards', '200', 'Result'), res.body),
    ).toEqual([]);
    expect(res.body).toMatchObject({
      first_six_digits: '542501',
      last_four_digits: '7793',
      brand: 'Mastercard',
      holder_name: 'Tony Stark',
      holder_document: '93095135270',
      exp_month: 1,
      exp_year: 2030,
      status: 'active',
      type: 'credit',
      label: 'Sua bandeira',
      billing_address: officialCardRequest.billing_address,
      customer: { id: customerId },
    });
    expect(res.body.id).toMatch(/^card_[A-Za-z0-9]{16}$/);
    expect(h.emitted).toEqual([{ type: 'card.created', data: res.body }]);
  });

  it('never renders the full number or the CVV', async () => {
    const res = await h.request('POST', base, { ...officialCardRequest, cvv: '987' });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('5425019448107793');
    expect(raw).not.toContain('987');
  });

  it('answers 422 exactly like the official example (missing exp_year)', async () => {
    const example = officialExample('POST', '/customers/{customer_id}/cards', '422') as { request: unknown };
    const res = await h.request('POST', base, example.request);
    expect(res.status).toBe(422);
    expect(res.body).toEqual(example);
  });

  it.each([
    ['an expired card', { exp_month: 9, exp_year: 2026 }, { card: ['The card expiration date is invalid.'] }],
    [
      'an invalid Luhn digit',
      { number: '5425019448107794' },
      { 'card.number': ['The number field is not a valid credit card number.'] },
    ],
    [
      'a short number',
      { number: '542501944810' },
      {
        'card.number': [
          'The field number must be a string with a minimum length of 13 and a maximum length of 19.',
        ],
      },
    ],
    [
      'a missing holder_name',
      { holder_name: undefined },
      { 'card.holder_name': ['The holder_name field is required.'] },
    ],
    [
      'a 5 digit cvv',
      { cvv: '12345' },
      {
        'card.cvv': ['The field cvv must be a string with a minimum length of 3 and a maximum length of 4.'],
      },
    ],
  ])('rejects %s', async (_case, change, errors) => {
    const res = await h.request('POST', base, { ...officialCardRequest, ...change });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(errors);
  });

  it('rejects numbers that pass Luhn but belong to no known brand', async () => {
    const res = await h.request('POST', base, { ...officialCardRequest, number: '9999999999999995' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({
      'card.number': ['The number field is not a valid credit card number.'],
    });
  });

  it('answers 404 for unknown customers, like the official example', async () => {
    const res = await h.request('POST', '/core/v5/customers/cus_xxxxxxxxxxxxxxxx/cards', officialCardRequest);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(officialExample('POST', '/customers/{customer_id}/cards', '404'));
  });

  it('copies the billing address from billing_address_id', async () => {
    const address = await h.request(
      'POST',
      `/core/v5/customers/${customerId}/addresses`,
      officialAddressRequest,
    );
    const { billing_address: _, ...card } = officialCardRequest;
    const res = await h.request('POST', base, { ...card, billing_address_id: address.body.id });
    expect(res.body.billing_address).toEqual({
      zip_code: '20021130',
      city: 'Rio de Janeiro',
      state: 'RJ',
      country: 'BR',
      line_1: '375, Av. General Justo, Centro',
      line_2: '8º andar',
    });
  });

  it('creates the card from a token, which can be used only once', async () => {
    const token = await createToken();
    const res = await h.request('POST', base, {
      token,
      billing_address: officialCardRequest.billing_address,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      brand: 'Visa',
      last_four_digits: '0010',
      exp_year: 2030,
      holder_name: 'Tony Stark',
    });

    const again = await h.request('POST', base, { token });
    expect(again.status).toBe(422);
    expect(again.body.errors).toEqual({ 'card.token': ['The token is invalid or expired.'] });
  });

  it('refuses tokens older than 60 seconds', async () => {
    const token = await createToken();
    h.clock.advance(61_000);
    const res = await h.request('POST', base, { token });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ 'card.token': ['The token is invalid or expired.'] });
  });
});

describe('GET /customers/{id}/cards', () => {
  it('lists the active cards newest first, without the customer', async () => {
    await h.request('POST', base, officialCardRequest);
    h.clock.advance(1000);
    const visa = await h.request('POST', base, { ...officialCardRequest, number: '4000000000000010' });
    const amex = await h.request('POST', base, {
      ...officialCardRequest,
      number: '378282246310005',
      cvv: '1234',
    });
    await h.request('DELETE', `${base}/${amex.body.id}`);

    const res = await h.request('GET', base);
    expect(res.status).toBe(200);
    expect(compareShape(officialExample('GET', '/customers/{customer_id}/cards', '200'), res.body)).toEqual(
      [],
    );
    expect(res.body.data.map((c: { id: string }) => c.id)[0]).toBe(visa.body.id);
    expect(res.body.data[0].customer).toBeUndefined();
    expect(res.body.paging).toEqual({ total: 2 });
  });
});

describe('GET /customers/{id}/cards/{card_id}', () => {
  it('gets the card with the official shape', async () => {
    const created = await h.request('POST', base, officialCardRequest);
    const res = await h.request('GET', `${base}/${created.body.id}`);
    expect(res.body).toEqual(created.body);
    expect(
      compareShape(
        officialExample('GET', '/customers/{customer_id}/cards/{card_id}', '200', 'Result'),
        res.body,
      ),
    ).toEqual([]);
  });

  it('answers 404 like the official example for unknown cards and cards of another customer', async () => {
    const other = await h.request('POST', '/core/v5/customers', { name: 'Other' });
    const card = await h.request('POST', `/core/v5/customers/${other.body.id}/cards`, officialCardRequest);
    for (const url of [`${base}/card_xxxxxxxxxxxxxxxx`, `${base}/${card.body.id}`]) {
      const res = await h.request('GET', url);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(officialExample('GET', '/customers/{customer_id}/cards/{card_id}', '404'));
    }
  });
});

describe('PUT /customers/{id}/cards/{card_id}', () => {
  it('updates holder, expiration and billing address', async () => {
    const created = await h.request('POST', base, officialCardRequest);
    h.clock.advance(1000);
    const res = await h.request('PUT', `${base}/${created.body.id}`, {
      holder_name: 'Peter Parker',
      exp_month: 12,
      exp_year: 2031,
      billing_address: { ...officialCardRequest.billing_address, line_2: '8º Andar' },
    });

    expect(res.status).toBe(200);
    expect(
      compareShape(officialExample('PUT', '/customers/{customer_id}/cards/{card_id}', '200'), res.body),
    ).toEqual([]);
    expect(res.body).toMatchObject({
      holder_name: 'Peter Parker',
      exp_month: 12,
      exp_year: 2031,
      billing_address: { line_2: '8º Andar' },
      updated_at: '2026-10-15T12:00:01Z',
    });
    expect(h.emitted.at(-1)).toEqual({ type: 'card.updated', data: res.body });
  });

  it('answers 422 exactly like the official example (key card.exp_date)', async () => {
    const created = await h.request('POST', base, officialCardRequest);
    const example = officialExample('PUT', '/customers/{customer_id}/cards/{card_id}', '422') as {
      request: unknown;
    };
    const res = await h.request('PUT', `${base}/${created.body.id}`, example.request);
    expect(res.status).toBe(422);
    expect(res.body).toEqual(example);
  });
});

describe('DELETE /customers/{id}/cards/{card_id}', () => {
  it('deletes logically with the official shape', async () => {
    const created = await h.request('POST', base, officialCardRequest);
    h.clock.advance(1000);
    const res = await h.request('DELETE', `${base}/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(
      compareShape(
        officialExample('DELETE', '/customers/{customer_id}/cards/{card_id}', '200', 'Result'),
        res.body,
      ),
    ).toEqual([]);
    expect(res.body).toMatchObject({ status: 'deleted', deleted_at: '2026-10-15T12:00:01Z' });
    expect((await h.request('GET', `${base}/${created.body.id}`)).body.status).toBe('deleted');
    expect(h.emitted.at(-1)).toEqual({ type: 'card.deleted', data: res.body });
  });
});

describe('POST /customers/{id}/cards/{card_id}/renew', () => {
  it('renews active cards', async () => {
    const created = await h.request('POST', base, officialCardRequest);
    const res = await h.request('POST', `${base}/${created.body.id}/renew`);
    expect(res.status).toBe(200);
    expect(
      compareShape(
        officialExample('POST', '/customers/{customer_id}/cards/{card_id}/renew', '200'),
        res.body,
      ),
    ).toEqual([]);
    expect(res.body.is_renewed).toBe(true);
  });

  it('answers 412 like the official example for deleted cards', async () => {
    const created = await h.request('POST', base, officialCardRequest);
    await h.request('DELETE', `${base}/${created.body.id}`);
    const res = await h.request('POST', `${base}/${created.body.id}/renew`);
    expect(res.status).toBe(412);
    expect(res.body).toEqual(
      officialExample('POST', '/customers/{customer_id}/cards/{card_id}/renew', '412'),
    );
  });
});
