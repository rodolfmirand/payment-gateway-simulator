import type { onRequestHookHandler } from 'fastify';
import type { CoreModule } from '../../context.js';
import { isAcceptedKey } from '../../plugins/auth.js';
import { UnauthorizedError } from '../../shared/errors.js';
import { parseRequest } from '../../shared/validation.js';
import { TokensService } from './service.js';
import { tokenCreateSchema, tokenView } from './token.js';

/** Called from the browser (tokenizecard.js), so it answers CORS, including on errors. */
const cors: onRequestHookHandler = (_request, reply, done) => {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-methods', 'POST, OPTIONS');
  reply.header('access-control-allow-headers', 'content-type');
  done();
};

/**
 * POST /tokens?appId=pk_... (docs/pagarme/reference/criar-token-cartao-1.md).
 * Authenticated by the public key in the query string, never by the secret key.
 */
export const tokensModule: CoreModule = async (app, ctx) => {
  const tokens = new TokensService(ctx);

  await app.register((scope) => {
    scope.addHook('onRequest', cors);

    scope.options('/tokens', { config: { auth: 'none' } }, (_request, reply) => reply.status(204).send());

    scope.post('/tokens', { config: { auth: 'none' } }, (request, reply) => {
      const { appId } = request.query as { appId?: unknown };
      if (typeof appId !== 'string' || !isAcceptedKey(appId, ctx.config.publicKeys, 'pk_')) {
        throw new UnauthorizedError();
      }
      const input = parseRequest(tokenCreateSchema(ctx.clock.now()), request.body, '');
      return reply.status(200).send(tokenView(tokens.create(input, request.body)));
    });
  });
};
