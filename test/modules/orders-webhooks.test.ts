import { afterEach, describe, expect, it } from 'vitest';
import { basicAuth, createTestApp, testConfig } from '../helpers/app.js';
import { startReceiver } from '../helpers/receiver.js';
import { officialOrderRequest } from './fixtures.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

describe('order flow end to end (real scheduler and webhook receiver)', () => {
  it('a processing card is confirmed on its own and the merchant receives every webhook', async () => {
    const receiver = await startReceiver();
    cleanup.push(receiver.close);
    const base = testConfig();
    const app = await createTestApp({
      config: { ...base, asyncDelayMs: 20, webhooks: { ...base.webhooks, urls: [receiver.url] } },
    });
    cleanup.push(() => app.close());

    const created = await app.inject({
      method: 'POST',
      url: '/core/v5/orders',
      headers: { authorization: basicAuth() },
      payload: officialOrderRequest('4000000000000036'),
    });
    expect(created.json().status).toBe('pending');

    await sleep(80); // the scheduled confirmation runs after SIMULATOR_ASYNC_DELAY_MS
    await app.inject({ method: 'POST', url: '/_simulator/webhooks/flush' });

    expect(receiver.received.map((request) => request.body.type)).toEqual([
      'customer.created',
      'order.created',
      'charge.created',
      'charge.processing',
      'charge.paid',
      'order.paid',
    ]);
    const orderPaid = receiver.received.at(-1)?.body;
    expect(orderPaid.data).toMatchObject({ id: created.json().id, status: 'paid' });
    expect(orderPaid.data.charges[0].last_transaction.status).toBe('captured');
  });
});
