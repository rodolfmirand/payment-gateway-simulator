import { z } from 'zod';
import { pageQuerySchema } from '../../shared/pagination.js';
import { integerish, metadataSchema, optional, stringish } from '../../shared/schemas.js';
import { billingAddressSchema } from '../cards/schemas.js';
import { paymentSchema } from '../charges/schemas.js';
import { customerInputSchema } from '../customers/schemas.js';

/** "order.items": ["The items field is required"] (docs/pagarme/reference/erros-1.md, no final period). */
const ITEMS_REQUIRED = 'The items field is required';

export const itemInputSchema = z.object({
  amount: integerish(z.number().int().min(1)),
  description: z.string().max(256),
  quantity: integerish(z.number().int().min(1)),
  code: optional(z.string().max(52)),
  category: optional(z.string().max(64)),
});
export type ItemInput = z.output<typeof itemInputSchema>;

const shippingSchema = z.object({
  amount: optional(integerish(z.number().int().min(0))),
  description: optional(z.string()),
  recipient_name: optional(z.string()),
  recipient_phone: optional(stringish()),
  address: optional(billingAddressSchema),
});

/** Body of POST /orders (docs/pagarme/reference/criar-pedido-2.md). */
export function orderCreateSchema(now: Date) {
  return z
    .object({
      code: optional(z.string().max(52)),
      items: z.array(itemInputSchema, { error: ITEMS_REQUIRED }).min(1, { error: ITEMS_REQUIRED }),
      customer_id: optional(z.string()),
      customer: optional(customerInputSchema),
      shipping: optional(shippingSchema),
      payments: optional(z.array(paymentSchema(now))),
      closed: optional(z.boolean()),
      metadata: optional(metadataSchema),
    })
    .superRefine((order, ctx) => {
      if (order.customer_id === undefined && order.customer === undefined) {
        ctx.addIssue({ code: 'custom', path: ['customer'], message: 'The customer field is required.' });
      }
      // Open orders (closed: false) may get their payments later through POST /charges.
      if (order.closed !== false && !order.payments?.length) {
        ctx.addIssue({ code: 'custom', path: ['payments'], message: 'The payments field is required.' });
      }
    });
}
export type OrderCreateInput = z.output<ReturnType<typeof orderCreateSchema>>;

/** Body of PATCH /orders/{id}/closed (docs/pagarme/reference/fechar-um-pedido.md). */
export const orderCloseSchema = z.object({ status: z.enum(['paid', 'canceled', 'failed']) });

/** Body of PUT /orders/{id}/items/{item_id}: same fields, `code` cannot change. */
export const itemUpdateSchema = itemInputSchema.omit({ code: true });

/** Query of GET /orders (docs/pagarme/reference/listar-pedidos.md): at most 30 orders per page. */
export const orderListQuerySchema = pageQuerySchema.extend({
  size: z.coerce
    .number()
    .int()
    .min(1)
    .default(10)
    .transform((size) => Math.min(size, 30)),
  code: optional(z.string()),
  status: optional(z.string()),
  customer_id: optional(z.string()),
  created_since: optional(z.string().refine((value) => !Number.isNaN(Date.parse(value)))),
  created_until: optional(z.string().refine((value) => !Number.isNaN(Date.parse(value)))),
});
