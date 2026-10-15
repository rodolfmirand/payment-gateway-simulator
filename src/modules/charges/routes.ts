import { z } from 'zod';
import type { CoreModule } from '../../context.js';
import { baseUrl } from '../../shared/pagination.js';
import { integerish, metadataSchema, optional } from '../../shared/schemas.js';
import { parseRequest } from '../../shared/validation.js';
import { customerInputSchema } from '../customers/schemas.js';
import { OrdersService } from '../orders/service.js';
import { paymentSchema } from './schemas.js';

/** Body of POST /charges (docs/pagarme/reference/incluir-cobranca-no-pedido.md). */
function chargeCreateSchema(now: Date) {
  return z.object({
    order_id: z.string(),
    amount: integerish(z.number().int().min(1)),
    payment: paymentSchema(now),
    due_at: optional(z.string()),
    customer_id: optional(z.string()),
    customer: optional(customerInputSchema),
    metadata: optional(metadataSchema),
  });
}

/** docs/pagarme/reference/cobrancas-1.md (the other charge operations come in stage 6). */
export const chargesModule: CoreModule = (app, ctx) => {
  const orders = new OrdersService(ctx);

  app.post('/charges', (request) => {
    const input = parseRequest(chargeCreateSchema(ctx.clock.now()), request.body, 'charge');
    return orders.addCharge(input, request.body, baseUrl(request));
  });
};
