import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_PUBLIC_KEY,
  basicAuth,
  createHarness,
  createTestApp,
  testConfig,
  type Harness,
} from '../helpers/app.js';
import { compareShape, officialExample } from '../helpers/contract.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.app.close();
});

const tokenRequest = {
  type: 'card',
  card: {
    number: '4000000000000010',
    holder_name: 'Tony Stark',
    exp_month: 1,
    exp_year: 30,
    cvv: '123',
    label: 'Sua bandeira',
  },
};

/** `appId: null` sends no appId at all. */
function postToken(
  payload: unknown,
  appId: string | null = TEST_PUBLIC_KEY,
  headers: Record<string, string> = {},
) {
  return h.app.inject({
    method: 'POST',
    url: appId === null ? '/core/v5/tokens' : `/core/v5/tokens?appId=${appId}`,
    payload: payload as object,
    headers,
  });
}

describe('POST /tokens', () => {
  it('creates a token like the official example, valid for 60 seconds', async () => {
    const res = await postToken(tokenRequest);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(compareShape(officialExample('POST', '/tokens', '200'), body)).toEqual([]);
    expect(body).toEqual({
      id: body.id,
      type: 'card',
      created_at: '2026-10-15T12:00:00Z',
      expires_at: '2026-10-15T12:01:00Z',
      card: {
        last_four_digits: '0010',
        holder_name: 'Tony Stark',
        exp_month: 1,
        exp_year: 30, // kept as sent, like the official example
        brand: 'Visa',
        label: 'Sua bandeira',
      },
    });
    expect(body.id).toMatch(/^token_[A-Za-z0-9]{16}$/);
  });

  it('is authenticated by the public key only, without the Authorization header', async () => {
    expect((await postToken(tokenRequest)).statusCode).toBe(200);
    expect((await postToken(tokenRequest, null)).statusCode).toBe(401);
    expect((await postToken(tokenRequest, 'sk_test_secret', { authorization: basicAuth() })).statusCode).toBe(
      401,
    );
    expect((await postToken(tokenRequest, null)).json()).toEqual({
      message: 'Authorization has been denied for this request.',
    });
  });

  it('accepts only the configured public keys when SIMULATOR_PUBLIC_KEYS is set', async () => {
    const app = await createTestApp({ config: testConfig({ publicKeys: ['pk_test_allowed'] }) });
    const call = (appId: string) =>
      app.inject({ method: 'POST', url: `/core/v5/tokens?appId=${appId}`, payload: tokenRequest });
    expect((await call('pk_test_allowed')).statusCode).toBe(200);
    expect((await call('pk_test_other')).statusCode).toBe(401);
    await app.close();
  });

  it('answers CORS, including the preflight and errors', async () => {
    const preflight = await h.app.inject({
      method: 'OPTIONS',
      url: `/core/v5/tokens?appId=${TEST_PUBLIC_KEY}`,
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-headers']).toBe('content-type');

    const error = await postToken({ type: 'card', card: {} });
    expect(error.statusCode).toBe(422);
    expect(error.headers['access-control-allow-origin']).toBe('*');
  });

  it('validates the card data', async () => {
    const res = await postToken({
      type: 'card',
      card: { number: '4000000000000011', exp_month: 1, exp_year: 30 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      message: 'The request is invalid.',
      errors: { 'card.number': ['The number field is not a valid credit card number.'] },
      request: { type: 'card', card: { number: '4000000000000011', exp_month: 1, exp_year: 30 } },
    });

    const expired = await postToken({
      type: 'card',
      card: { number: '4000000000000010', exp_month: 1, exp_year: 20 },
    });
    expect(expired.json().errors).toEqual({ card: ['The card expiration date is invalid.'] });
  });
});

describe('GET /bin/v1/{bin}', () => {
  it('returns the brand data like the official example', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/bin/v1/542501' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(officialExample('GET', '/{bin}', '200'));
  });

  it('answers 404 with an empty object for unknown BINs', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/bin/v1/999999' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({});
  });
});
