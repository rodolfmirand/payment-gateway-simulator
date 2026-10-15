import type { FastifyInstance } from 'fastify';

/**
 * JSON body parser that accepts an empty body (e.g. DELETE /charges/{id} sent by HTTP clients that always add
 * Content-Type: application/json). Malformed JSON still fails with 400.
 */
export function registerJsonBodyParser(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error('Malformed JSON body'), { statusCode: 400 }), undefined);
    }
  });
}
