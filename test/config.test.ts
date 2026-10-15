import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('has defaults for everything', () => {
    expect(loadConfig({})).toEqual({
      port: 4000,
      host: '0.0.0.0',
      logLevel: 'info',
      secretKeys: [],
      publicKeys: [],
      account: { id: 'acc_Sim0000000000001', name: 'Pagar.me Simulator' },
      asyncDelayMs: 5000,
      webhooks: { urls: [], events: [], maxAttempts: 3, retryDelayMs: 5000, timeoutMs: 5000 },
    });
  });

  it('parses the webhook settings', () => {
    const config = loadConfig({
      SIMULATOR_WEBHOOK_URLS: 'http://user:pass@app:3000/webhooks, https://example.dev/hooks',
      SIMULATOR_WEBHOOK_EVENTS: 'order.paid,charge.paid',
      SIMULATOR_WEBHOOK_MAX_ATTEMPTS: '5',
      SIMULATOR_WEBHOOK_RETRY_DELAY_MS: '100',
      SIMULATOR_WEBHOOK_TIMEOUT_MS: '2000',
    });
    expect(config.webhooks).toEqual({
      urls: ['http://user:pass@app:3000/webhooks', 'https://example.dev/hooks'],
      events: ['order.paid', 'charge.paid'],
      maxAttempts: 5,
      retryDelayMs: 100,
      timeoutMs: 2000,
    });
    expect(() => loadConfig({ SIMULATOR_WEBHOOK_URLS: 'ftp://x' })).toThrow(/SIMULATOR_WEBHOOK_URLS/);
  });

  it('parses comma separated keys and numbers', () => {
    const config = loadConfig({
      PORT: '8080',
      SIMULATOR_SECRET_KEYS: 'sk_test_a, sk_test_b,',
      SIMULATOR_PUBLIC_KEYS: 'pk_test_a',
      SIMULATOR_ASYNC_DELAY_MS: '0',
    });
    expect(config.port).toBe(8080);
    expect(config.secretKeys).toEqual(['sk_test_a', 'sk_test_b']);
    expect(config.publicKeys).toEqual(['pk_test_a']);
    expect(config.asyncDelayMs).toBe(0);
  });

  it('rejects invalid values naming the variable', () => {
    expect(() => loadConfig({ PORT: 'abc', SIMULATOR_ACCOUNT_ID: 'x' })).toThrow(
      /PORT[\s\S]*SIMULATOR_ACCOUNT_ID/,
    );
  });
});
