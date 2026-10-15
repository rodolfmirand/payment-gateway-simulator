import { describe, expect, it } from 'vitest';
import { Store } from '../../src/shared/store/store.js';
import { createTestApp } from '../helpers/app.js';

describe('/_simulator', () => {
  it('GET /health reports ok', async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/_simulator/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('POST /reset wipes every repository', async () => {
    const store = new Store();
    store.repository<{ id: string }>('customers').insert({ id: 'cus_1' });
    const app = await createTestApp({ store });

    const res = await app.inject({ method: 'POST', url: '/_simulator/reset' });

    expect(res.statusCode).toBe(204);
    expect(store.repository('customers').findAll()).toEqual([]);
    await app.close();
  });
});
