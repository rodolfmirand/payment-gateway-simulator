import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoreModule } from '../../src/context.js';
import { basicAuthUser } from '../../src/plugins/auth.js';
import { basicAuth, createTestApp, testConfig } from '../helpers/app.js';
import { officialExample } from '../helpers/contract.js';

const probe: CoreModule = (app) => {
  app.get('/probe', () => ({ ok: true }));
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function call(authorization?: string, secretKeys: string[] = []) {
  app = await createTestApp({ config: testConfig({ secretKeys }), modules: [probe] });
  return app.inject({
    method: 'GET',
    url: '/core/v5/probe',
    headers: authorization ? { authorization } : {},
  });
}

describe('secret key authentication', () => {
  it('accepts any sk_ key with empty password when no keys are configured', async () => {
    const res = await call(basicAuth('sk_test_anything'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('answers exactly like Pagar.me when the header is missing', async () => {
    const res = await call();
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(officialExample('GET', '/customers', '401'));
  });

  it.each([
    ['public key instead of secret key', basicAuth('pk_test_123')],
    ['empty user', basicAuth('')],
    ['bare prefix', basicAuth('sk_')],
    ['Bearer scheme', 'Bearer sk_test_123'],
    ['garbage', 'Basic'],
  ])('rejects %s', async (_case, header) => {
    const res = await call(header);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ message: 'Authorization has been denied for this request.' });
  });

  it('accepts only the configured keys when SIMULATOR_SECRET_KEYS is set', async () => {
    expect((await call(basicAuth('sk_test_allowed'), ['sk_test_allowed'])).statusCode).toBe(200);
    await app?.close();
    expect((await call(basicAuth('sk_test_other'), ['sk_test_allowed'])).statusCode).toBe(401);
  });

  it('does not protect the simulator control endpoints', async () => {
    app = await createTestApp();
    expect((await app.inject({ method: 'GET', url: '/_simulator/health' })).statusCode).toBe(200);
  });
});

describe('basicAuthUser', () => {
  it('extracts the user and ignores the password', () => {
    expect(basicAuthUser(basicAuth('sk_test_1'))).toBe('sk_test_1');
    expect(basicAuthUser(`Basic ${Buffer.from('sk_test_1:secret').toString('base64')}`)).toBe('sk_test_1');
    expect(basicAuthUser(`basic ${Buffer.from('sk_test_1').toString('base64')}`)).toBe('sk_test_1');
    expect(basicAuthUser(undefined)).toBeUndefined();
  });
});
