import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { optional } from '../../shared/schemas.js';
import { parseRequest } from '../../shared/validation.js';
import { WebhookEndpointsService, endpointInputSchema, endpointView } from './endpoints.js';
import { hookEnvelope, publicUrl, type Hook } from './hook.js';

const deliveriesQuerySchema = z.object({
  event: optional(z.string()),
  status: optional(z.enum(['pending', 'sent', 'failed'])),
});

/** Simulator control endpoints for webhooks (/_simulator/...). */
export function webhookSimulatorRoutes(app: FastifyInstance, ctx: AppContext): void {
  const endpoints = new WebhookEndpointsService(ctx);
  const hooks = ctx.store.repository<Hook>('hooks');

  app.get('/webhook-endpoints', () => ({ data: endpoints.list().map(endpointView) }));

  app.post('/webhook-endpoints', (request, reply) => {
    const input = parseRequest(endpointInputSchema, request.body, '');
    return reply.status(201).send(endpointView(endpoints.create(input)));
  });

  app.delete<{ Params: { id: string } }>('/webhook-endpoints/:id', (request, reply) => {
    endpoints.delete(request.params.id);
    return reply.status(204).send();
  });

  /** Every hook in emission order, with the exact body sent and the history of attempts. */
  app.get('/webhook-deliveries', (request) => {
    const { event, status } = parseRequest(deliveriesQuerySchema, request.query, '');
    const data = hooks
      .findAll(
        (hook) =>
          (event === undefined || hook.event === event) && (status === undefined || hook.status === status),
      )
      .map((hook) => ({
        id: hook.id,
        endpoint_id: hook.endpoint_id,
        url: publicUrl(hook.target),
        event: hook.event,
        status: hook.status,
        attempts: hook.attempts,
        max_attempts: hook.max_attempts,
        created_at: hook.created_at,
        payload: hookEnvelope(hook, ctx.config.account),
        history: hook.history,
      }));
    return { data };
  });

  /** Waits until every queued webhook was delivered or gave up (useful before asserting in tests). */
  app.post('/webhooks/flush', async (_request, reply) => {
    await ctx.webhooks.idle();
    return reply.status(204).send();
  });
}
