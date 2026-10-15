import type { FastifyInstance } from 'fastify';
import { binInfo, detectBrand } from '../cards/card-number.js';

/**
 * GET /bin/v1/{bin} (docs/pagarme/reference/obter-informacoes-do-bin.md), served under its own base path
 * like the real api.pagar.me/bin/v1. Unknown BINs answer 404 with an empty object, as documented.
 */
export function binRoutes(app: FastifyInstance): void {
  app.get<{ Params: { bin: string } }>('/:bin', (request, reply) => {
    const brand = /^\d{6,}$/.test(request.params.bin) ? detectBrand(request.params.bin) : undefined;
    return brand ? binInfo(brand) : reply.status(404).send({});
  });
}
