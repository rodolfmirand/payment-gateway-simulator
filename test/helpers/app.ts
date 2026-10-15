import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { Clock } from '../../src/shared/clock.js';
import { EventBus, type DomainEvent } from '../../src/shared/events.js';

export const TEST_SECRET_KEY = 'sk_test_simulator';
export const TEST_PUBLIC_KEY = 'pk_test_simulator';

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

/** Clock the tests move by hand. */
export class TestClock implements Clock {
  private current: Date;

  constructor(start = '2026-10-15T12:00:00Z') {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Record<string, unknown>;
}

/** Test harness: app + clock + captured domain events + authenticated request helper. */
export async function createHarness(options: Partial<BuildAppOptions> = {}) {
  const clock = new TestClock();
  const events = new EventBus();
  const emitted: DomainEvent[] = [];
  events.subscribe((event) => emitted.push(event));
  const app = await createTestApp({ clock, events, ...options });

  async function request(method: string, url: string, payload?: unknown, auth = true): Promise<ApiResponse> {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: auth ? { authorization: basicAuth() } : {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined, headers: res.headers };
  }

  return { app, clock, emitted, request };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
