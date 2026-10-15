import type { onRequestHookHandler } from 'fastify';
import type { Config } from '../config.js';
import { UnauthorizedError } from '../shared/errors.js';

/** Extracts the user of a Basic Auth header (Pagar.me: user = secret key, empty password). */
export function basicAuthUser(header: string | undefined): string | undefined {
  const match = /^Basic\s+(\S+)\s*$/i.exec(header ?? '');
  if (!match?.[1]) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  const user = separator === -1 ? decoded : decoded.slice(0, separator);
  return user || undefined;
}

export function isAcceptedKey(key: string, accepted: readonly string[], prefix: 'sk_' | 'pk_'): boolean {
  if (accepted.length > 0) return accepted.includes(key);
  return key.startsWith(prefix) && key.length > prefix.length;
}

/** onRequest hook for the /core/v5 routes authenticated with the secret key. */
export function secretKeyAuth(config: Pick<Config, 'secretKeys'>): onRequestHookHandler {
  return (request, _reply, done) => {
    const key = basicAuthUser(request.headers.authorization);
    if (!key || !isAcceptedKey(key, config.secretKeys, 'sk_')) {
      done(new UnauthorizedError());
      return;
    }
    done();
  };
}
