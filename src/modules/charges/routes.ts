import { z } from 'zod';
import type { CoreModule } from '../../context.js';
import { baseUrl, pageQuerySchema, paginate, requestUrl } from '../../shared/pagination.js';
import { integerish, metadataSchema, optional } from '../../shared/schemas.js';
import { parseRequest } from '../../shared/validation.js';
import { customerInputSchema } from '../customers/schemas.js';
import { OrdersService } from '../orders/service.js';
import { creditCardPaymentSchema, dateString, paymentSchema } from './schemas.js';
import { ChargesService } from './service.js';

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

/** Body of capture and cancel: an optional partial amount (split is accepted and ignored). */
const amountSchema = z.object({ amount: optional(integerish(z.number().int().min(1))) });

const listQuerySchema = pageQuerySchema.extend({
  code: optional(z.string()),
  status: optional(z.string()),
  payment_method: optional(z.string()),
  customer_id: optional(z.string()),
  order_id: optional(z.string()),
  created_since: optional(dateString),
  created_until: optional(dateString),
});

type ChargeParams = { Params: { charge_id: string } };

/** docs/pagarme/reference/cobrancas-1.md */
export const chargesModule: CoreModule = (app, ctx) => {
  const orders = new OrdersService(ctx);
  const charges = new ChargesService(ctx);

  app.post('/charges', (request) => {
    const input = parseRequest(chargeCreateSchema(ctx.clock.now()), request.body, 'charge');
    return orders.addCharge(input, request.body, baseUrl(request));
  });

  app.get('/charges', (request) => {
    const { page, size, ...filters } = parseRequest(listQuerySchema, request.query, '');
    const views = charges.list(filters).map((charge) => charges.view(charge, true));
    return paginate(views, { page, size }, requestUrl(request));
  });

  app.get<ChargeParams>('/charges/:charge_id', (request) =>
    charges.view(charges.get(request.params.charge_id), true),
  );

  app.post<ChargeParams>('/charges/:charge_id/capture', (request) => {
    const { amount } = parseRequest(amountSchema, request.body, 'charge');
    return charges.capture(request.params.charge_id, amount);
  });

  app.delete<ChargeParams>('/charges/:charge_id', (request) => {
    const { amount } = parseRequest(amountSchema, request.body, 'charge');
    return charges.cancel(request.params.charge_id, amount);
  });

  app.post<ChargeParams>('/charges/:charge_id/retry', (request) => charges.retry(request.params.charge_id));

  app.patch<ChargeParams>('/charges/:charge_id/card', (request) => {
    const input = parseRequest(creditCardPaymentSchema(ctx.clock.now()), request.body, 'charge');
    return charges.changeCard(request.params.charge_id, input, request.body);
  });

  app.patch<ChargeParams>('/charges/:charge_id/due-date', (request) => {
    const { due_at } = parseRequest(z.object({ due_at: dateString }), request.body, 'charge');
    return charges.changeDueDate(request.params.charge_id, due_at);
  });

  app.patch<ChargeParams>('/charges/:charge_id/payment-method', (request) => {
    const payment = parseRequest(paymentSchema(ctx.clock.now()), request.body, 'charge');
    return charges.changePaymentMethod(request.params.charge_id, payment, request.body, baseUrl(request));
  });
};
