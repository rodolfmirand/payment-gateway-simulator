import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { AppContext, BaseContext, CoreModule } from './context.js';
import { addressesModule } from './modules/addresses/routes.js';
import { binRoutes } from './modules/bin/routes.js';
import { cardsModule } from './modules/cards/routes.js';
import { transactionFilesModule } from './modules/charges/files-routes.js';
import { chargesModule } from './modules/charges/routes.js';
import { ordersModule } from './modules/orders/routes.js';
import { customersModule } from './modules/customers/routes.js';
import { tokensModule } from './modules/tokens/routes.js';
import { WebhookDispatcher } from './modules/webhooks/dispatcher.js';
import { webhooksModule } from './modules/webhooks/routes.js';
import { secretKeyAuth } from './plugins/auth.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { systemClock, type Clock } from './shared/clock.js';
import { EventBus } from './shared/events.js';
import { Scheduler } from './shared/scheduler.js';
import { Store } from './shared/store/store.js';
import { simulatorRoutes } from './simulator/routes.js';

export const CORE_PREFIX = '/core/v5';
export const BIN_PREFIX = '/bin/v1';

/** Modules served under /core/v5. Filled in as the stages of the plan are implemented. */
export const coreModules: CoreModule[] = [
  customersModule,
  addressesModule,
  cardsModule,
  tokensModule,
  webhooksModule,
  ordersModule,
  chargesModule,
  transactionFilesModule,
];

export interface BuildAppOptions {
  config: Config;
  clock?: Clock;
  store?: Store;
  events?: EventBus;
  scheduler?: Scheduler;
  modules?: CoreModule[];
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
  });

  const base: BaseContext = {
    config,
    clock: options.clock ?? systemClock,
    store: options.store ?? new Store(),
    events: options.events ?? new EventBus(),
    scheduler:
      options.scheduler ??
      new Scheduler(config.asyncDelayMs, (error, label) => {
        app.log.error({ err: error, task: label }, 'scheduled transition failed');
      }),
  };
  const ctx: AppContext = { ...base, webhooks: new WebhookDispatcher(base, app.log) };
  ctx.events.subscribe((event) => {
    ctx.webhooks.handle(event);
  });
  app.addHook('onClose', () => {
    ctx.scheduler.cancelAll();
    ctx.webhooks.cancelRetries();
  });

  registerErrorHandling(app);

  await app.register(
    (instance) => {
      simulatorRoutes(instance, ctx);
    },
    { prefix: '/_simulator' },
  );

  await app.register(binRoutes, { prefix: BIN_PREFIX });

  await app.register(
    async (core) => {
      core.addHook('onRequest', secretKeyAuth(config));
      for (const module of options.modules ?? coreModules) await module(core, ctx);
    },
    { prefix: CORE_PREFIX },
  );

  return app;
}
