import { z } from 'zod';
import { integerish, metadataSchema, optional } from '../../shared/schemas.js';
import { EXPIRATION_INVALID, NUMBER_LENGTH, isExpirationValid, isLuhnValid } from '../cards/card-number.js';
import { billingAddressSchema, cvvSchema } from '../cards/schemas.js';

/** Message of docs/pagarme/reference/erros-1.md for an invalid number inside an order (no final period). */
export const PAYMENT_CARD_NUMBER_INVALID = 'The number field is not a valid card number';

const paymentCardSchema = z.object({
  number: optional(
    z.string().min(13, { error: NUMBER_LENGTH, abort: true }).max(19, { error: NUMBER_LENGTH, abort: true }),
  ),
  holder_name: optional(z.string().max(64)),
  holder_document: optional(z.string()),
  exp_month: optional(integerish()),
  exp_year: optional(integerish()),
  cvv: optional(cvvSchema),
  brand: optional(z.string()),
  label: optional(z.string()),
  billing_address_id: optional(z.string().max(36)),
  billing_address: optional(billingAddressSchema),
});

/** `credit_card` of a payment (docs/pagarme/reference/cartao-de-credito-1.md). */
function creditCardPaymentSchema(now: Date) {
  return z
    .object({
      installments: optional(integerish(z.number().int().min(1))),
      statement_descriptor: optional(z.string().max(22)),
      operation_type: optional(z.enum(['auth_and_capture', 'auth_only', 'pre_auth'])),
      /** Legacy flag used by the simulator guide: capture=false is the same as auth_only. */
      capture: optional(z.boolean()),
      card: optional(paymentCardSchema),
      card_id: optional(z.string()),
      card_token: optional(z.string()),
      recurrence_cycle: optional(z.enum(['first', 'subsequent'])),
      metadata: optional(metadataSchema),
    })
    .superRefine((payment, ctx) => {
      if (payment.card_id !== undefined || payment.card_token !== undefined) return;
      const { card } = payment;
      if (!card) {
        ctx.addIssue({
          code: 'custom',
          path: [],
          message: 'The card_id, card_token or card field is required.',
        });
        return;
      }
      for (const field of ['number', 'holder_name'] as const) {
        if (card[field] === undefined) {
          ctx.addIssue({ code: 'custom', path: ['card', field], message: `The ${field} field is required.` });
        }
      }
      if (card.number !== undefined && !isLuhnValid(card.number)) {
        ctx.addIssue({ code: 'custom', path: ['card'], message: PAYMENT_CARD_NUMBER_INVALID });
      }
      if (!isExpirationValid(card.exp_month, card.exp_year, now)) {
        ctx.addIssue({ code: 'custom', path: ['card'], message: EXPIRATION_INVALID });
      }
    });
}
export type CreditCardPaymentInput = z.output<ReturnType<typeof creditCardPaymentSchema>>;

/** An item of `payments` (docs/pagarme/reference/visao-geral-sobre-pagamento.md). */
export function paymentSchema(now: Date) {
  return z
    .object({
      payment_method: z.enum(['credit_card']),
      credit_card: optional(creditCardPaymentSchema(now)),
      amount: optional(integerish(z.number().int().min(1))),
      metadata: optional(metadataSchema),
    })
    .superRefine((payment, ctx) => {
      // The object named after the payment method is required, e.g. "credit_card" for credit_card.
      const method = payment.payment_method;
      if (payment[method] === undefined) {
        ctx.addIssue({ code: 'custom', path: [method], message: `The ${method} field is required.` });
      }
    });
}
export type PaymentInput = z.output<ReturnType<typeof paymentSchema>>;
