import { afterEach, describe, expect, it } from 'vitest';
import type { WebhookConfig } from '../../src/config.js';
import { createHarness, testConfig, type Harness } from '../helpers/app.js';
import { compareShape, officialExample } from '../helpers/contract.js';
import { startReceiver, type ReceiverReply } from '../helpers/receiver.js';
import { officialCardRequest } from './fixtures.js';

type Receiver = Awaited<ReturnType<typeof startReceiver>>;

let h: Harness | undefined;
let receivers: Receiver[] = [];

afterEach(async () => {
  await h?.app.close();
  h = undefined;
  await Promise.all(receivers.map((r) => r.close()));
  receivers = [];
});

async function receiver(respond?: (count: number) => ReceiverReply) {
  const r = await startReceiver(respond);
  receivers.push(r);
  return r;
}

async function harness(webhooks: Partial<WebhookConfig>) {
  const base = testConfig();
  h = await createHarness({
    config: { ...base, webhooks: { ...base.webhooks, retryDelayMs: 10, ...webhooks } },
  });
  return h;
}

async function flush(harness: Harness) {
  const res = await harness.request('POST', '/_simulator/webhooks/flush', undefined, false);
  expect(res.status).toBe(204);
}

describe('webhook delivery', () => {
  it('POSTs the official envelope to the configured URL and records the hook as sent', async () => {
    const r = await receiver(() => ({ status: 200, body: 'received' }));
    const s = await harness({ urls: [r.url] });

    const customer = await s.request('POST', '/core/v5/customers', { name: 'Tony Stark' });
    await flush(s);

    expect(r.received).toHaveLength(1);
    const [delivery] = r.received;
    expect(delivery?.method).toBe('POST');
    expect(delivery?.path).toBe('/webhooks');
    expect(delivery?.headers['content-type']).toBe('application/json');
    expect(delivery?.body).toEqual({
      id: expect.stringMatching(/^hook_[A-Za-z0-9]{16}$/),
      account: { id: 'acc_Sim0000000000001', name: 'Pagar.me Simulator' },
      type: 'customer.created',
      created_at: '2026-10-15T12:00:00', // no "Z", as in exemplo-de-webhook-1.md
      data: customer.body,
    });
    const example = officialExample('GET', '/hooks/{hook_id}', '200') as Record<string, unknown>;
    expect(compareShape({ ...example, data: null }, delivery?.body)).toEqual([
      'missing $.url',
      'missing $.event',
      'missing $.status',
      'missing $.attempts',
      'missing $.last_attempt',
      'missing $.response_status',
      'missing $.response_raw',
    ]);

    const hook = await s.request('GET', `/core/v5/hooks/${delivery?.body.id as string}`);
    expect(hook.status).toBe(200);
    expect(compareShape({ ...example, data: null }, hook.body)).toEqual([]);
    expect(hook.body).toEqual({
      id: delivery?.body.id,
      url: r.url,
      account: { id: 'acc_Sim0000000000001', name: 'Pagar.me Simulator' },
      event: 'customer.created',
      status: 'sent',
      attempts: '1/3',
      last_attempt: '2026-10-15T12:00:00Z',
      created_at: '2026-10-15T12:00:00Z',
      response_status: 200,
      response_raw: 'received',
      data: customer.body,
    });
  });

  it('creates no hooks when no endpoint is configured', async () => {
    const s = await harness({ urls: [] });
    await s.request('POST', '/core/v5/customers', { name: 'Tony' });
    expect((await s.request('GET', '/core/v5/hooks')).body).toEqual({ data: [], paging: { total: 0 } });
  });

  it('sends only the events of SIMULATOR_WEBHOOK_EVENTS', async () => {
    const r = await receiver();
    const s = await harness({ urls: [r.url], events: ['card.created'] });

    const customer = await s.request('POST', '/core/v5/customers', { name: 'Tony' });
    await s.request('POST', `/core/v5/customers/${customer.body.id as string}/cards`, officialCardRequest);
    await flush(s);

    expect(r.received.map((req) => req.body.type)).toEqual(['card.created']);
  });

  it('delivers the events of one endpoint in the order they happened', async () => {
    const r = await receiver(() => ({ status: 200, delayMs: 5 }));
    const s = await harness({ urls: [r.url] });

    const customer = await s.request('POST', '/core/v5/customers', { name: 'Tony' });
    const id = customer.body.id as string;
    await s.request('PUT', `/core/v5/customers/${id}`, { name: 'Tony Stark' });
    const card = await s.request('POST', `/core/v5/customers/${id}/cards`, officialCardRequest);
    await s.request('DELETE', `/core/v5/customers/${id}/cards/${card.body.id as string}`);
    await flush(s);

    expect(r.received.map((req) => req.body.type)).toEqual([
      'customer.created',
      'customer.updated',
      'card.created',
      'card.deleted',
    ]);
  });

  it('sends Basic auth when the URL carries credentials, without exposing them', async () => {
    const r = await receiver();
    const withAuth = r.url.replace('http://', 'http://merchant:s3cr%40t@');
    const s = await harness({ urls: [withAuth] });

    await s.request('POST', '/core/v5/customers', { name: 'Tony' });
    await flush(s);

    expect(r.received[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('merchant:s3cr@t').toString('base64')}`,
    );
    const hooks = await s.request('GET', '/core/v5/hooks');
    expect(hooks.body.data[0].url).toBe(r.url);
    expect(JSON.stringify(hooks.body)).not.toContain('s3cr');
  });
});

describe('webhook retries', () => {
  it('retries failures until the endpoint answers 2xx', async () => {
    const r = await receiver((n) => (n < 3 ? { status: 500, body: 'boom' } : { status: 204 }));
    const s = await harness({ urls: [r.url] });

    await s.request('POST', '/core/v5/customers', { name: 'Tony' });
    await flush(s);

    expect(r.received).toHaveLength(3);
    expect(new Set(r.received.map((req) => req.body.id)).size).toBe(1); // same hook id on every attempt
    const [hook] = (await s.request('GET', '/core/v5/hooks')).body.data;
    expect(hook).toMatchObject({ status: 'sent', attempts: '3/3', response_status: 204, response_raw: '' });
  });

  it('marks the hook as failed after the last attempt', async () => {
    const r = await receiver(() => ({ status: 404, body: 'Tunnel not found' }));
    const s = await harness({ urls: [r.url], maxAttempts: 2 });

    await s.request('POST', '/core/v5/customers', { name: 'Tony' });
    await flush(s);

    expect(r.received).toHaveLength(2);
    const [hook] = (await s.request('GET', '/core/v5/hooks?status=failed')).body.data;
    expect(hook).toMatchObject({
      status: 'failed',
      attempts: '2/2',
      response_status: 404,
      response_raw: 'Tunnel not found',
    });
  });

  it('records connection errors and timeouts', async () => {
    const slow = await receiver(() => ({ status: 200, delayMs: 300 }));
    const closed = await receiver();
    await closed.close();
    const s = await harness({ urls: [slow.url, closed.url], maxAttempts: 1, timeoutMs: 50 });

    await s.request('POST', '/core/v5/customers', { name: 'Tony' });
    await flush(s);

    const deliveries = (await s.request('GET', '/_simulator/webhook-deliveries', undefined, false)).body.data;
    expect(deliveries.map((d: { status: string }) => d.status)).toEqual(['failed', 'failed']);
    expect(deliveries[0].history[0].error).toMatch(/timeout|aborted/i);
    expect(deliveries[1].history[0].error).toMatch(/ECONNREFUSED/);
    const hook = (await s.request('GET', `/core/v5/hooks/${deliveries[1].id as string}`)).body;
    expect(hook.response_status).toBeUndefined();
    expect(hook.response_raw).toMatch(/ECONNREFUSED/);
  });

  it('POST /hooks/{id}/retry sends once more and answers 200 {}', async () => {
    let healthy = false;
    const r = await receiver(() => (healthy ? { status: 200 } : { status: 500 }));
    const s = await harness({ urls: [r.url], maxAttempts: 1 });

    await s.request('POST', '/core/v5/customers', { name: 'Tony' });
    await flush(s);
    const [failed] = (await s.request('GET', '/core/v5/hooks')).body.data;
    expect(failed.status).toBe('failed');

    healthy = true;
    const res = await s.request('POST', `/core/v5/hooks/${failed.id as string}/retry`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(officialExample('POST', '/hooks/{hook_id}/retry', '200'));

    const hook = (await s.request('GET', `/core/v5/hooks/${failed.id as string}`)).body;
    expect(hook).toMatchObject({ status: 'sent', attempts: '2/1', response_status: 200 });
    expect(r.received).toHaveLength(2);
  });
});

describe('GET /hooks', () => {
  it('lists newest first with the filters of the docs', async () => {
    const r = await receiver();
    const s = await harness({ urls: [r.url] });

    const customer = await s.request('POST', '/core/v5/customers', { name: 'Tony' });
    s.clock.advance(60_000);
    await s.request('POST', `/core/v5/customers/${customer.body.id as string}/cards`, officialCardRequest);
    await flush(s);

    const all = (await s.request('GET', '/core/v5/hooks')).body;
    expect(all.data.map((hook: { event: string }) => hook.event)).toEqual([
      'card.created',
      'customer.created',
    ]);
    expect(all.paging).toEqual({ total: 2 });

    const byEvent = (await s.request('GET', '/core/v5/hooks?webhook_event=customer.created')).body;
    expect(byEvent.data).toHaveLength(1);
    const since = (await s.request('GET', '/core/v5/hooks?created_since=2026-10-15T12:00:30Z')).body;
    expect(since.data.map((hook: { event: string }) => hook.event)).toEqual(['card.created']);
    const until = (await s.request('GET', '/core/v5/hooks?created_until=2026-10-15T12:00:30Z')).body;
    expect(until.data.map((hook: { event: string }) => hook.event)).toEqual(['customer.created']);
    const paged = (await s.request('GET', '/core/v5/hooks?size=1')).body;
    expect(paged.paging).toEqual({ total: 2, next: 'http://localhost/core/v5/hooks?size=1&page=2' });
  });

  it('answers 400 {} for unknown hooks, as documented', async () => {
    const s = await harness({ urls: [] });
    for (const [method, url] of [
      ['GET', '/core/v5/hooks/hook_xxxxxxxxxxxxxxxx'],
      ['POST', '/core/v5/hooks/hook_xxxxxxxxxxxxxxxx/retry'],
    ] as const) {
      const res = await s.request(method, url);
      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        officialExample(method, url.includes('retry') ? '/hooks/{hook_id}/retry' : '/hooks/{hook_id}', '400'),
      );
    }
  });

  it('requires the secret key', async () => {
    const s = await harness({ urls: [] });
    expect((await s.request('GET', '/core/v5/hooks', undefined, false)).status).toBe(401);
  });
});

describe('/_simulator webhook endpoints', () => {
  it('adds, lists and removes endpoints, with an optional event filter', async () => {
    const configured = await receiver();
    const added = await receiver();
    const s = await harness({ urls: [configured.url] });

    const created = await s.request(
      'POST',
      '/_simulator/webhook-endpoints',
      { url: added.url.replace('http://', 'http://u:p@'), events: ['customer.updated'] },
      false,
    );
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.stringMatching(/^we_[A-Za-z0-9]{16}$/),
      url: added.url,
      events: ['customer.updated'],
      basic_auth: true,
      source: 'api',
      created_at: '2026-10-15T12:00:00Z',
    });

    const list = await s.request('GET', '/_simulator/webhook-endpoints', undefined, false);
    expect(list.body.data).toEqual([
      { id: 'we_config_1', url: configured.url, events: [], basic_auth: false, source: 'config' },
      created.body,
    ]);

    const customer = await s.request('POST', '/core/v5/customers', { name: 'Tony' });
    await s.request('PUT', `/core/v5/customers/${customer.body.id as string}`, { name: 'Tony Stark' });
    await flush(s);
    expect(configured.received.map((req) => req.body.type)).toEqual(['customer.created', 'customer.updated']);
    expect(added.received.map((req) => req.body.type)).toEqual(['customer.updated']);

    expect(
      (
        await s.request(
          'DELETE',
          `/_simulator/webhook-endpoints/${created.body.id as string}`,
          undefined,
          false,
        )
      ).status,
    ).toBe(204);
    expect(
      (await s.request('GET', '/_simulator/webhook-endpoints', undefined, false)).body.data,
    ).toHaveLength(1);
  });

  it('validates the endpoint and refuses to remove configured or unknown ones', async () => {
    const s = await harness({ urls: ['http://127.0.0.1:1/webhooks'] });

    const invalid = await s.request(
      'POST',
      '/_simulator/webhook-endpoints',
      { url: 'nope', events: ['order.nope'] },
      false,
    );
    expect(invalid.status).toBe(422);
    expect(Object.keys(invalid.body.errors)).toEqual(['url', 'events[0]']);

    const config = await s.request('DELETE', '/_simulator/webhook-endpoints/we_config_1', undefined, false);
    expect(config.status).toBe(412);
    const unknown = await s.request(
      'DELETE',
      '/_simulator/webhook-endpoints/we_xxxxxxxxxxxxxxxx',
      undefined,
      false,
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ message: 'Webhook endpoint not found.' });
  });

  it('lists deliveries with the exact payload and the attempt history', async () => {
    const r = await receiver((n) => (n === 1 ? { status: 503 } : { status: 200 }));
    const s = await harness({ urls: [r.url] });

    await s.request('POST', '/core/v5/customers', { name: 'Tony' });
    await flush(s);

    const [delivery] = (
      await s.request('GET', '/_simulator/webhook-deliveries?event=customer.created', undefined, false)
    ).body.data;
    expect(delivery).toMatchObject({
      event: 'customer.created',
      status: 'sent',
      attempts: 2,
      max_attempts: 3,
    });
    expect(delivery.payload).toEqual(r.received[1]?.body);
    expect(delivery.history.map((a: { response_status: number }) => a.response_status)).toEqual([503, 200]);
  });

  it('reset wipes hooks and endpoints added by API, but keeps the configured ones', async () => {
    const r = await receiver();
    const s = await harness({ urls: [r.url] });
    await s.request('POST', '/_simulator/webhook-endpoints', { url: 'http://127.0.0.1:1/x' }, false);
    await s.request('POST', '/core/v5/customers', { name: 'Tony' });
    await flush(s);

    await s.request('POST', '/_simulator/reset', undefined, false);

    expect((await s.request('GET', '/core/v5/hooks')).body.data).toEqual([]);
    expect((await s.request('GET', '/_simulator/webhook-endpoints', undefined, false)).body.data).toEqual([
      { id: 'we_config_1', url: r.url, events: [], basic_auth: false, source: 'config' },
    ]);
  });
});
