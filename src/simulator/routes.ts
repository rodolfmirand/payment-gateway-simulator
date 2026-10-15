import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

/** Simulator control endpoints (/_simulator). They do not exist on Pagar.me and need no authentication. */
export function simulatorRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', () => ({ status: 'ok' }));

  app.post('/reset', (_request, reply) => {
    ctx.store.reset();
    return reply.status(204).send();
  });
}
