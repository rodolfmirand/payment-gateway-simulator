import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Clock } from './shared/clock.js';
import type { EventBus } from './shared/events.js';
import type { Store } from './shared/store/store.js';

/** Dependencies shared by every module. */
export interface AppContext {
  config: Config;
  clock: Clock;
  store: Store;
  events: EventBus;
}

/** A group of /core/v5 routes (customers, orders...). Registered behind secret key auth. */
export type CoreModule = (app: FastifyInstance, ctx: AppContext) => void | Promise<void>;

declare module 'fastify' {
  interface FastifyContextConfig {
    /** "none" skips the secret key check (e.g. /tokens, authenticated by the public key). Default: "secret". */
    auth?: 'secret' | 'none';
  }
}
