import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { webhookSimulatorRoutes } from '../modules/webhooks/simulator-routes.js';

/** Simulator control endpoints (/_simulator). They do not exist on Pagar.me and need no authentication. */
export function simulatorRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', () => ({ status: 'ok' }));

  /** Wipes all data, including webhook endpoints added by API; the ones from the configuration remain. */
  app.post('/reset', (_request, reply) => {
    ctx.scheduler.cancelAll();
    ctx.webhooks.cancelRetries();
    ctx.store.reset();
    return reply.status(204).send();
  });

  webhookSimulatorRoutes(app, ctx);
}
