import { compact } from '../../shared/schemas.js';

export type HookStatus = 'pending' | 'sent' | 'failed';

export interface HookAttempt {
  at: string;
  response_status?: number;
  response_raw?: string;
  error?: string;
  duration_ms: number;
  manual: boolean;
}

/** One event sent to one endpoint (docs/pagarme/reference/visao-geral-sobre-webhooks.md). */
export interface Hook {
  id: string;
  endpoint_id: string;
  /** Where the hook is posted. May carry user:password for Basic auth; never rendered. */
  target: string;
  event: string;
  status: HookStatus;
  attempts: number;
  max_attempts: number;
  last_attempt?: string;
  response_status?: number;
  response_raw?: string;
  data: unknown;
  created_at: string;
  /** Simulator only: every attempt, exposed by /_simulator/webhook-deliveries. */
  history: HookAttempt[];
}

/** The URL without the credentials. */
export function publicUrl(target: string): string {
  const url = new URL(target);
  url.username = '';
  url.password = '';
  return url.toString();
}

/** Hook as rendered by GET /hooks. `attempts` is a "made/max" string, as in the official examples. */
export function hookView(hook: Hook, account: { id: string; name: string }) {
  return compact({
    id: hook.id,
    url: publicUrl(hook.target),
    account,
    event: hook.event,
    status: hook.status,
    attempts: `${hook.attempts}/${hook.max_attempts}`,
    last_attempt: hook.last_attempt,
    created_at: hook.created_at,
    response_status: hook.response_status,
    response_raw: hook.response_raw,
    data: hook.data,
  });
}

/**
 * Body POSTed to the endpoint (docs/pagarme/reference/exemplo-de-webhook-1.md). The id is the hook id and,
 * as in the official example, `created_at` has no time zone suffix.
 */
export function hookEnvelope(hook: Hook, account: { id: string; name: string }) {
  return {
    id: hook.id,
    account,
    type: hook.event,
    created_at: hook.created_at.replace(/Z$/, ''),
    data: hook.data,
  };
}
