import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app.js';
import { compareShape, officialExample } from '../helpers/contract.js';
import { officialCustomerRequest } from './fixtures.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.app.close();
});

describe('POST /customers', () => {
  it('creates the customer with the same shape as the official example', async () => {
    const res = await h.request('POST', '/core/v5/customers', officialCustomerRequest());

    expect(res.status).toBe(200);
    expect(compareShape(officialExample('POST', '/customers', '200'), res.body)).toEqual([]);
    expect(res.body).toMatchObject({
      name: 'Tony Stark',
      email: 'tonystarkk@avengers.com',
      code: 'MY_CUSTOMER_001',
      document_type: 'CPF',
      type: 'individual',
      gender: 'male',
      delinquent: false,
      birthdate: '1984-05-03T00:00:00Z',
      created_at: '2026-10-15T12:00:00Z',
      updated_at: '2026-10-15T12:00:00Z',
      metadata: { company: 'Avengers' },
      address: { line_1: '375, Av. General Justo, Centro', status: 'active' },
    });
    expect(res.body.id).toMatch(/^cus_[A-Za-z0-9]{16}$/);
    expect(res.body.address.id).toMatch(/^addr_[A-Za-z0-9]{16}$/);
  });

  it('omits the fields that were not sent, but always renders phones', async () => {
    const res = await h.request('POST', '/core/v5/customers', { name: 'Only Name' });
    expect(res.body).toEqual({
      id: res.body.id,
      name: 'Only Name',
      delinquent: false,
      created_at: '2026-10-15T12:00:00Z',
      updated_at: '2026-10-15T12:00:00Z',
      phones: {},
    });
  });

  it('answers 422 exactly like the official example', async () => {
    const example = officialExample('POST', '/customers', '422') as { request: unknown };
    const res = await h.request('POST', '/core/v5/customers', example.request);
    expect(res.status).toBe(422);
    expect(res.body).toEqual(example);
  });

  it('requires type when document is sent', async () => {
    const res = await h.request('POST', '/core/v5/customers', { name: 'A', document: '93095135270' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ 'customer.type': ['The type field is required.'] });
  });

  it('validates e-mail, enums and lengths with Pagar.me messages', async () => {
    const res = await h.request('POST', '/core/v5/customers', {
      name: 'x'.repeat(65),
      email: 'not-an-email',
      type: 'person',
    });
    expect(res.body.errors).toEqual({
      'customer.name': ['The field name must be a string with a maximum length of 64.'],
      'customer.email': ['The email field is not a valid e-mail address.'],
      'customer.type': ["The type field is invalid. Possible values are 'individual' or 'company'."],
    });
  });

  it('accepts the birthdate as yyyy-mm-dd or mm/dd/yyyy and rejects invalid dates', async () => {
    const iso = await h.request('POST', '/core/v5/customers', { name: 'A', birthdate: '1984-05-03' });
    const us = await h.request('POST', '/core/v5/customers', { name: 'B', birthdate: '05/03/1984' });
    const bad = await h.request('POST', '/core/v5/customers', { name: 'C', birthdate: '1984-02-30' });
    expect(iso.body.birthdate).toBe('1984-05-03T00:00:00Z');
    expect(us.body.birthdate).toBe('1984-05-03T00:00:00Z');
    expect(bad.body.errors).toEqual({ 'customer.birthdate': ['The birthdate field is invalid.'] });
  });

  it('reuses the customer when the e-mail already exists (e-mail is a unique key)', async () => {
    const first = await h.request('POST', '/core/v5/customers', { name: 'Tony', email: 'tony@avengers.com' });
    h.clock.advance(1000);
    const second = await h.request('POST', '/core/v5/customers', {
      name: 'Tony Stark',
      email: 'tony@avengers.com',
      code: 'C1',
    });

    expect(second.body.id).toBe(first.body.id);
    expect(second.body).toMatchObject({ name: 'Tony Stark', code: 'C1', updated_at: '2026-10-15T12:00:01Z' });
    expect(h.emitted.map((e) => e.type)).toEqual(['customer.created', 'customer.updated']);
  });

  it('emits customer.created with the rendered customer', async () => {
    const res = await h.request('POST', '/core/v5/customers', { name: 'Tony' });
    expect(h.emitted).toEqual([{ type: 'customer.created', data: res.body }]);
  });
});

describe('GET /customers/{id}', () => {
  it('returns the customer with the official shape', async () => {
    const created = await h.request('POST', '/core/v5/customers', officialCustomerRequest());
    const res = await h.request('GET', `/core/v5/customers/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
    expect(compareShape(officialExample('GET', '/customers/{customer_id}', '200'), res.body)).toEqual([]);
  });

  it('answers 404 exactly like the official example', async () => {
    const res = await h.request('GET', '/core/v5/customers/cus_xxxxxxxxxxxxxxxx');
    expect(res.status).toBe(404);
    expect(res.body).toEqual(officialExample('GET', '/customers/{customer_id}', '404'));
  });
});

describe('PUT /customers/{id}', () => {
  it('replaces the fields sent and keeps the others', async () => {
    const created = await h.request('POST', '/core/v5/customers', officialCustomerRequest());
    h.clock.advance(5000);
    const res = await h.request('PUT', `/core/v5/customers/${created.body.id}`, {
      name: 'Peter Parker',
      email: 'parker@avengers.com',
      phones: { home_phone: { country_code: '55', number: '0000002000', area_code: '021' } },
    });

    expect(res.status).toBe(200);
    expect(compareShape(officialExample('PUT', '/customers/{customer_id}', '200'), res.body)).toEqual([]);
    expect(res.body).toMatchObject({
      id: created.body.id,
      name: 'Peter Parker',
      email: 'parker@avengers.com',
      code: 'MY_CUSTOMER_001',
      phones: { home_phone: { number: '0000002000' } },
      created_at: '2026-10-15T12:00:00Z',
      updated_at: '2026-10-15T12:00:05Z',
    });
    expect(res.body.phones.mobile_phone).toBeUndefined();
    expect(h.emitted.at(-1)?.type).toBe('customer.updated');
  });

  it('updates the main address in place', async () => {
    const created = await h.request('POST', '/core/v5/customers', officialCustomerRequest());
    const res = await h.request('PUT', `/core/v5/customers/${created.body.id}`, {
      name: 'Tony Stark',
      address: {
        line_1: '1, Rua Nova, Centro',
        zip_code: '01001000',
        city: 'São Paulo',
        state: 'SP',
        country: 'BR',
      },
    });
    expect(res.body.address).toMatchObject({ id: created.body.address.id, line_1: '1, Rua Nova, Centro' });
  });

  it('answers 422 exactly like the official example', async () => {
    const created = await h.request('POST', '/core/v5/customers', { name: 'Tony' });
    const example = officialExample('PUT', '/customers/{customer_id}', '422') as { request: unknown };
    const res = await h.request('PUT', `/core/v5/customers/${created.body.id}`, example.request);
    expect(res.status).toBe(422);
    expect(res.body).toEqual(example);
  });

  it('answers 404 for unknown customers', async () => {
    const res = await h.request('PUT', '/core/v5/customers/cus_xxxxxxxxxxxxxxxx', { name: 'A' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Customer not found.' });
  });
});

describe('GET /customers', () => {
  it('lists newest first, filters by exact match and paginates', async () => {
    for (const [name, gender] of [
      ['Ana', 'female'],
      ['Bruno', 'male'],
      ['Carla', 'female'],
    ]) {
      await h.request('POST', '/core/v5/customers', { name, gender });
      h.clock.advance(1000);
    }

    const all = await h.request('GET', '/core/v5/customers');
    expect(all.body.data.map((c: { name: string }) => c.name)).toEqual(['Carla', 'Bruno', 'Ana']);
    expect(all.body.paging).toEqual({ total: 3 });
    // The official list example is not valid JSON; items have the shape of a single customer.
    expect(compareShape(officialExample('GET', '/customers/{customer_id}', '200'), all.body.data[0])).toEqual(
      ['missing $.email', 'missing $.address', 'missing $.metadata'],
    );

    const female = await h.request('GET', '/core/v5/customers?gender=female&size=1');
    expect(female.body.data.map((c: { name: string }) => c.name)).toEqual(['Carla']);
    expect(female.body.paging).toEqual({
      total: 2,
      next: 'http://localhost/core/v5/customers?gender=female&size=1&page=2',
    });
  });

  it('requires the secret key', async () => {
    const res = await h.request('GET', '/core/v5/customers', undefined, false);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(officialExample('GET', '/customers', '401'));
  });
});
