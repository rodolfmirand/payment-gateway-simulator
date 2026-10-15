import type { FastifyBaseLogger } from 'fastify';
import type { BaseContext } from '../../context.js';
import { formatDate } from '../../shared/clock.js';
import type { DomainEvent } from '../../shared/events.js';
import { generateId } from '../../shared/ids.js';
import type { Repository } from '../../shared/store/repository.js';
import { WebhookEndpointsService } from './endpoints.js';
import { hookEnvelope, type Hook, type HookAttempt } from './hook.js';

const RESPONSE_RAW_LIMIT = 4096;

/** URL without credentials + Authorization header built from them (fetch refuses URLs with credentials). */
function requestTarget(target: string): { url: string; headers: Record<string, string> } {
  const url = new URL(target);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (url.username || url.password) {
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    headers.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
    url.username = '';
    url.password = '';
  }
  return { url: url.toString(), headers };
}

/**
 * Turns domain events into hooks and POSTs them to the subscribed endpoints.
 * Deliveries to the same endpoint happen one at a time, in event order; failures are retried
 * after `retryDelayMs` until `maxAttempts`.
 */
export class WebhookDispatcher {
  private readonly hooks: Repository<Hook>;
  private readonly endpoints: WebhookEndpointsService;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private pending = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly ctx: BaseContext,
    private readonly log: FastifyBaseLogger,
  ) {
    this.hooks = ctx.store.repository<Hook>('hooks');
    this.endpoints = new WebhookEndpointsService(ctx);
  }

  /** Creates one hook per subscribed endpoint (status "pending") and queues its delivery. */
  handle(event: DomainEvent): void {
    for (const endpoint of this.endpoints.subscribedTo(event.type)) {
      const hook = this.hooks.insert({
        id: generateId('hook'),
        endpoint_id: endpoint.id,
        target: endpoint.url,
        event: event.type,
        status: 'pending',
        attempts: 0,
        max_attempts: this.ctx.config.webhooks.maxAttempts,
        data: event.data,
        created_at: formatDate(this.ctx.clock.now()),
        history: [],
      });
      this.enqueue(hook.id, endpoint.id);
    }
  }

  /** POST /hooks/{id}/retry: sends once more right away, even if the attempts are exhausted. */
  async retry(hookId: string): Promise<void> {
    this.pending++;
    try {
      await this.attempt(hookId, true);
    } finally {
      this.settle();
    }
  }

  /** Resolves when nothing is queued, in flight or waiting for a retry. */
  idle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Drops the scheduled retries (used by /_simulator/reset and on shutdown). */
  cancelRetries(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.pending -= this.timers.size;
    this.timers.clear();
    if (this.pending === 0) this.notifyIdle();
  }

  private enqueue(hookId: string, endpointId: string): void {
    this.pending++;
    const previous = this.queues.get(endpointId) ?? Promise.resolve();
    const next = previous
      .then(() => this.attempt(hookId, false))
      .catch((error: unknown) => {
        this.log.error({ err: error, hookId }, 'webhook delivery crashed');
      })
      .finally(() => {
        this.settle();
      });
    this.queues.set(endpointId, next);
  }

  private async attempt(hookId: string, manual: boolean): Promise<void> {
    const hook = this.hooks.findById(hookId);
    if (!hook) return; // removed by /_simulator/reset

    const { url, headers } = requestTarget(hook.target);
    const body = JSON.stringify(hookEnvelope(hook, this.ctx.config.account));
    const started = performance.now();
    const result: Omit<HookAttempt, 'at' | 'duration_ms' | 'manual'> = {};
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.ctx.config.webhooks.timeoutMs),
      });
      result.response_status = response.status;
      result.response_raw = (await response.text()).slice(0, RESPONSE_RAW_LIMIT);
    } catch (error) {
      result.error =
        error instanceof Error
          ? error.cause instanceof Error
            ? error.cause.message
            : error.message
          : String(error);
      result.response_raw = result.error;
    }

    const current = this.hooks.findById(hookId);
    if (!current) return;
    const attempts = current.attempts + 1;
    const sent =
      result.response_status !== undefined && result.response_status >= 200 && result.response_status < 300;
    const exhausted = attempts >= current.max_attempts;
    const at = formatDate(this.ctx.clock.now());
    this.hooks.update({
      ...current,
      attempts,
      status: sent ? 'sent' : exhausted ? 'failed' : 'pending',
      last_attempt: at,
      response_status: result.response_status,
      response_raw: result.response_raw,
      history: [
        ...current.history,
        { at, ...result, duration_ms: Math.round(performance.now() - started), manual },
      ],
    });
    this.log.info(
      { hookId, event: current.event, url, status: result.response_status, error: result.error },
      sent ? 'webhook sent' : 'webhook delivery failed',
    );

    if (!sent && !exhausted && !manual) this.scheduleRetry(hookId, current.endpoint_id);
  }

  private scheduleRetry(hookId: string, endpointId: string): void {
    this.pending++;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.enqueue(hookId, endpointId);
      this.settle();
    }, this.ctx.config.webhooks.retryDelayMs);
    this.timers.add(timer);
  }

  private settle(): void {
    this.pending--;
    if (this.pending === 0) this.notifyIdle();
  }

  private notifyIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
