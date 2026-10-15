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
    });
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
