import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { compareShape, officialExample } from '../helpers/contract.js';
import { customerForEmbedding, officialAddressRequest, officialCustomerRequest } from './fixtures.js';

let h: Harness;
let customerId: string;
let base: string;

beforeEach(async () => {
  h = await createHarness();
  customerId = (await h.request('POST', '/core/v5/customers', customerForEmbedding)).body.id as string;
  base = `/core/v5/customers/${customerId}/addresses`;
  h.emitted.length = 0;
});
afterEach(async () => {
  await h.app.close();
});

describe('POST /customers/{id}/addresses', () => {
  it('creates the address with the embedded customer, like the official example', async () => {
    const res = await h.request('POST', base, officialAddressRequest);

    expect(res.status).toBe(200);
    expect(
      compareShape(officialExample('POST', '/customers/{customer_id}/addresses', '200'), res.body),
    ).toEqual([]);
    expect(res.body).toMatchObject({
      ...officialAddressRequest,
      status: 'active',
      customer: { id: customerId, name: 'Tony Stark' },
    });
    expect(res.body.id).toMatch(/^addr_[A-Za-z0-9]{16}$/);
    expect(h.emitted).toEqual([{ type: 'address.created', data: res.body }]);
  });

  it('answers 422 exactly like the official example', async () => {
    const example = officialExample('POST', '/customers/{customer_id}/addresses', '422') as {
      request: unknown;
    };
    const res = await h.request('POST', base, example.request);
    expect(res.status).toBe(422);
    expect(res.body).toEqual(example);
  });

  it('answers 404 for unknown customers, like the official example', async () => {
    const res = await h.request(
      'POST',
      '/core/v5/customers/cus_xxxxxxxxxxxxxxxx/addresses',
      officialAddressRequest,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual(officialExample('POST', '/customers/{customer_id}/addresses', '404'));
  });

  it('accepts zip_code as a number', async () => {
    const res = await h.request('POST', base, { ...officialAddressRequest, zip_code: 20021130 });
    expect(res.body.zip_code).toBe('20021130');
  });
});

describe('GET, PUT and DELETE /customers/{id}/addresses/{address_id}', () => {
  it('gets the address', async () => {
    const created = await h.request('POST', base, officialAddressRequest);
    const res = await h.request('GET', `${base}/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
    expect(
      compareShape(
        officialExample('GET', '/customers/{customer_id}/addresses/{address_id}', '200'),
        res.body,
      ),
    ).toEqual(
      ['missing $.deleted_at'], // the official example shows a deleted address
    );
  });

  it('answers 404 for unknown addresses and for addresses of another customer', async () => {
    const other = await h.request('POST', '/core/v5/customers', { name: 'Other' });
    const created = await h.request(
      'POST',
      `/core/v5/customers/${other.body.id}/addresses`,
      officialAddressRequest,
    );

    for (const url of [`${base}/addr_xxxxxxxxxxxxxxxx`, `${base}/${created.body.id}`]) {
      const res = await h.request('GET', url);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(
        officialExample('GET', '/customers/{customer_id}/addresses/{address_id}', '404'),
      );
    }
  });

  it('updates only line_2 and metadata', async () => {
    const created = await h.request('POST', base, officialAddressRequest);
    h.clock.advance(2000);
    const res = await h.request('PUT', `${base}/${created.body.id}`, {
      line_1: 'ignored',
      line_2: '10º andar',
      metadata: { id: 'work' },
    });

    expect(res.status).toBe(200);
    expect(
      compareShape(
        officialExample('PUT', '/customers/{customer_id}/addresses/{address_id}', '200'),
        res.body,
      ),
    ).toEqual([]);
    expect(res.body).toMatchObject({
      line_1: officialAddressRequest.line_1,
      line_2: '10º andar',
      metadata: { id: 'work' },
      updated_at: '2026-10-15T12:00:02Z',
    });
    expect(h.emitted.at(-1)).toEqual({ type: 'address.updated', data: res.body });
  });

  it('deletes logically: status deleted, still readable, gone from the list', async () => {
    const created = await h.request('POST', base, officialAddressRequest);
    h.clock.advance(3000);
    const res = await h.request('DELETE', `${base}/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'deleted', deleted_at: '2026-10-15T12:00:03Z' });
    expect(
      compareShape(
        officialExample('DELETE', '/customers/{customer_id}/addresses/{address_id}', '200'),
        res.body,
      ),
    ).toEqual(
      ['missing $.street', 'missing $.number', 'missing $.neighborhood'], // deprecated fields (enderecos.md)
    );
    expect((await h.request('GET', `${base}/${created.body.id}`)).body.status).toBe('deleted');
    expect((await h.request('GET', base)).body).toEqual({ data: [], paging: { total: 0 } });
    expect(h.emitted.at(-1)).toEqual({ type: 'address.deleted', data: res.body });
  });
});

describe('GET /customers/{id}/addresses', () => {
  it('lists active addresses newest first, without the customer', async () => {
    await h.request('POST', base, officialAddressRequest);
    h.clock.advance(1000);
    await h.request('POST', base, {
      ...officialAddressRequest,
      line_1: '10882, Malibu Point, Central Malibu',
    });

    const res = await h.request('GET', base);
    expect(res.status).toBe(200);
    expect(
      compareShape(officialExample('GET', '/customers/{customer_id}/addresses', '200'), res.body),
    ).toEqual([]);
    expect(res.body.data[0].line_1).toBe('10882, Malibu Point, Central Malibu');
    expect(res.body.data[0].customer).toBeUndefined();
    expect(res.body.paging).toEqual({ total: 2 });
  });

  it('includes the main address created with the customer', async () => {
    const customer = await h.request('POST', '/core/v5/customers', officialCustomerRequest());
    const res = await h.request('GET', `/core/v5/customers/${customer.body.id}/addresses`);
    expect(res.body.data).toEqual([customer.body.address]);
  });

  it('answers 404 for unknown customers', async () => {
    const res = await h.request('GET', '/core/v5/customers/cus_xxxxxxxxxxxxxxxx/addresses');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Customer not found.' });
  });
});
