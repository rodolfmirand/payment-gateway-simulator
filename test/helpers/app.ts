import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';

export const TEST_SECRET_KEY = 'sk_test_simulator';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ LOG_LEVEL: 'silent' }), ...overrides };
}

export async function createTestApp(options: Partial<BuildAppOptions> = {}): Promise<FastifyInstance> {
  const app = await buildApp({ config: testConfig(), ...options });
  await app.ready();
  return app;
}

/** Authorization header as Pagar.me expects it: Basic base64("<secret key>:") */
export function basicAuth(key: string = TEST_SECRET_KEY): string {
  return `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
}
