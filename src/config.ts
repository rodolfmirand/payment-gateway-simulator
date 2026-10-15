import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Accepted secret keys (Basic Auth user). Empty = any key starting with "sk_".
  SIMULATOR_SECRET_KEYS: csv,
  // Accepted public keys (appId on /tokens). Empty = any key starting with "pk_".
  SIMULATOR_PUBLIC_KEYS: csv,
  SIMULATOR_ACCOUNT_ID: z
    .string()
    .regex(/^acc_[A-Za-z0-9]+$/, 'must look like acc_XXXXXXXXXXXXXXXX')
    .default('acc_Sim0000000000001'),
  SIMULATOR_ACCOUNT_NAME: z.string().min(1).default('Pagar.me Simulator'),
  // Delay before automatic transitions (e.g. Pix paid, processing -> paid). Used from stage 4 on.
  SIMULATOR_ASYNC_DELAY_MS: z.coerce.number().int().min(0).default(5000),
  // Webhook endpoints (on Pagar.me they are set in the dashboard). Basic auth goes in the URL: http://user:pass@host/path
  SIMULATOR_WEBHOOK_URLS: csv.pipe(z.array(z.url({ protocol: /^https?$/ }))),
  // Events sent to the endpoints above. Empty = all events.
  SIMULATOR_WEBHOOK_EVENTS: csv,
  SIMULATOR_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  SIMULATOR_WEBHOOK_RETRY_DELAY_MS: z.coerce.number().int().min(0).default(5000),
  SIMULATOR_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1).default(5000),
});

export interface WebhookConfig {
  urls: string[];
  events: string[];
  maxAttempts: number;
  retryDelayMs: number;
  timeoutMs: number;
}

export interface Config {
  port: number;
  host: string;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  secretKeys: string[];
  publicKeys: string[];
  account: { id: string; name: string };
  asyncDelayMs: number;
  webhooks: WebhookConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${details.join('\n')}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    secretKeys: e.SIMULATOR_SECRET_KEYS,
    publicKeys: e.SIMULATOR_PUBLIC_KEYS,
    account: { id: e.SIMULATOR_ACCOUNT_ID, name: e.SIMULATOR_ACCOUNT_NAME },
    asyncDelayMs: e.SIMULATOR_ASYNC_DELAY_MS,
    webhooks: {
      urls: e.SIMULATOR_WEBHOOK_URLS,
      events: e.SIMULATOR_WEBHOOK_EVENTS,
      maxAttempts: e.SIMULATOR_WEBHOOK_MAX_ATTEMPTS,
      retryDelayMs: e.SIMULATOR_WEBHOOK_RETRY_DELAY_MS,
      timeoutMs: e.SIMULATOR_WEBHOOK_TIMEOUT_MS,
    },
  };
}
