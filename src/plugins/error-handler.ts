import type { FastifyInstance } from 'fastify';
import { PagarmeError } from '../shared/errors.js';

// Not documented by Pagar.me. Its API is ASP.NET Web API (e.g. "Authorization has been denied for
// this request."), so these follow the framework's default bodies.
const NOT_FOUND = (url: string) => `No HTTP resource was found that matches the request URI '${url}'.`;
const INVALID_REQUEST = 'The request is invalid.';
const INTERNAL_ERROR = 'An error has occurred.';

function hasStatusCode(error: unknown): error is { statusCode: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
  );
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PagarmeError) {
      return reply.status(error.statusCode).send(error.toBody());
    }
    // Fastify's own client errors: malformed JSON, empty JSON body, unsupported media type...
    if (hasStatusCode(error) && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.info({ err: error }, 'rejected request');
      return reply.status(error.statusCode).send({ message: INVALID_REQUEST });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ message: INTERNAL_ERROR });
  });

  app.setNotFoundHandler((request, reply) => {
    const url = `${request.protocol}://${request.host}${request.url}`;
    return reply.status(404).send({ message: NOT_FOUND(url) });
  });
}
