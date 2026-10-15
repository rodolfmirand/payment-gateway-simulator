import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CoreModule } from '../../src/context.js';
import { NotFoundError, PreconditionFailedError } from '../../src/shared/errors.js';
import { parseRequest } from '../../src/shared/validation.js';
import { basicAuth, createTestApp } from '../helpers/app.js';
import { officialExample } from '../helpers/contract.js';

const customerSchema = z.object({ name: z.string(), email: z.string().optional() });
const addressSchema = z.object({ line_1: z.string(), zip_code: z.string() });

const probe: CoreModule = (app) => {
  app.get('/customers/:id', () => {
    throw new NotFoundError('Customer');
  });
  app.post('/customers', (request) => parseRequest(customerSchema, request.body, 'customer'));
  app.post('/addresses', (request) => parseRequest(addressSchema, request.body, 'address'));
  app.post('/charges/capture', () => {
    throw new PreconditionFailedError('This charge can not be captured.');
  });
  app.get('/boom', () => {
    throw new Error('unexpected');
  });
};

let app: FastifyInstance;
beforeAll(async () => {
  app = await createTestApp({ modules: [probe] });
});
afterAll(async () => {
  await app.close();
});

const auth = { authorization: basicAuth() };

describe('Pagar.me error bodies', () => {
  it('404 matches the official example', async () => {
    const res = await app.inject({ method: 'GET', url: '/core/v5/customers/cus_x', headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(officialExample('GET', '/customers/{customer_id}', '404'));
  });

  it('422 for a customer matches the official example byte for byte', async () => {
    const example = officialExample('POST', '/customers', '422') as { request: unknown };
    const res = await app.inject({
      method: 'POST',
      url: '/core/v5/customers',
      headers: auth,
      payload: example.request as object,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual(example);
  });

  it('422 for an address matches the official example byte for byte', async () => {
    const example = officialExample('POST', '/customers/{customer_id}/addresses', '422') as {
      request: unknown;
    };
    const res = await app.inject({
      method: 'POST',
      url: '/core/v5/addresses',
      headers: auth,
      payload: example.request as object,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual(example);
  });

  it('412 carries the message', async () => {
    const res = await app.inject({ method: 'POST', url: '/core/v5/charges/capture', headers: auth });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toEqual({ message: 'This charge can not be captured.' });
  });

  it('422 with an empty body echoes {} as the request', async () => {
    const res = await app.inject({ method: 'POST', url: '/core/v5/customers', headers: auth });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      message: 'The request is invalid.',
      errors: { 'customer.name': ['The name field is required.'] },
      request: {},
    });
  });
});

describe('errors not documented by Pagar.me (ASP.NET Web API defaults)', () => {
  it('unknown route -> 404 naming the URI', async () => {
    const res = await app.inject({ method: 'GET', url: '/core/v5/nope?x=1', headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      message:
        "No HTTP resource was found that matches the request URI 'http://localhost:80/core/v5/nope?x=1'.",
    });
  });

  it('malformed JSON -> 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/core/v5/customers',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ message: 'The request is invalid.' });
  });

  it('an empty body with Content-Type: application/json is accepted as no body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/core/v5/customers',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(422); // validated as {}, not rejected as malformed
    expect(res.json().request).toEqual({});
  });

  it('unexpected exception -> 500 without leaking details', async () => {
    const res = await app.inject({ method: 'GET', url: '/core/v5/boom', headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ message: 'An error has occurred.' });
  });
});
