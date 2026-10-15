import { z } from 'zod';
import type { BaseContext } from '../../context.js';
import { formatDate } from '../../shared/clock.js';
import { NotFoundError, PreconditionFailedError } from '../../shared/errors.js';
import { DOCUMENTED_EVENTS } from '../../shared/events.js';
import { generateId } from '../../shared/ids.js';
import { compact, optional } from '../../shared/schemas.js';
import type { Repository } from '../../shared/store/repository.js';
import { publicUrl } from './hook.js';

/**
 * Where webhooks are sent. On Pagar.me they are set in the dashboard; here they come from the configuration
 * (SIMULATOR_WEBHOOK_URLS) or from POST /_simulator/webhook-endpoints.
 */
export interface WebhookEndpoint {
  id: string;
  url: string;
  /** Empty = every event. */
  events: string[];
  source: 'config' | 'api';
  created_at?: string;
}

export const endpointInputSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  events: optional(z.array(z.enum(DOCUMENTED_EVENTS))),
});

export function endpointView(endpoint: WebhookEndpoint) {
  const url = new URL(endpoint.url);
  return compact({
    id: endpoint.id,
    url: publicUrl(endpoint.url),
    events: endpoint.events,
    basic_auth: url.username !== '' || url.password !== '',
    source: endpoint.source,
    created_at: endpoint.created_at,
  });
}

export class WebhookEndpointsService {
  private readonly endpoints: Repository<WebhookEndpoint>;

  constructor(private readonly ctx: BaseContext) {
    this.endpoints = ctx.store.repository<WebhookEndpoint>('webhook_endpoints');
  }

  /** Endpoints of the configuration first (they survive /_simulator/reset), then the ones added by API. */
  list(): WebhookEndpoint[] {
    const { urls, events } = this.ctx.config.webhooks;
    const fromConfig = urls.map((url, index): WebhookEndpoint => ({
      id: `we_config_${index + 1}`,
      url,
      events,
      source: 'config',
    }));
    return [...fromConfig, ...this.endpoints.findAll()];
  }

  subscribedTo(event: string): WebhookEndpoint[] {
    return this.list().filter((endpoint) => endpoint.events.length === 0 || endpoint.events.includes(event));
  }

  create(input: z.output<typeof endpointInputSchema>): WebhookEndpoint {
    return this.endpoints.insert({
      id: generateId('we'),
      url: input.url,
      events: input.events ?? [],
      source: 'api',
      created_at: formatDate(this.ctx.clock.now()),
    });
  }

  delete(id: string): void {
    if (this.list().some((endpoint) => endpoint.id === id && endpoint.source === 'config')) {
      throw new PreconditionFailedError('Webhook endpoints from the configuration cannot be removed.');
    }
    if (!this.endpoints.delete(id)) throw new NotFoundError('Webhook endpoint');
  }
}
