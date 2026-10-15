import { z } from 'zod';
import { integerish, metadataSchema, optional, stringish } from '../../shared/schemas.js';
import {
  EXPIRATION_INVALID,
  NUMBER_INVALID,
  NUMBER_LENGTH,
  isExpirationValid,
  isLuhnValid,
} from './card-number.js';

export const cardNumberSchema = z
  .string()
  .min(13, { error: NUMBER_LENGTH, abort: true })
  .max(19, { error: NUMBER_LENGTH, abort: true })
  .refine(isLuhnValid, { error: NUMBER_INVALID });

export const cvvSchema = stringish(
  z.string().regex(/^\d{3,4}$/, {
    error: 'The field cvv must be a string with a minimum length of 3 and a maximum length of 4.',
  }),
);

/** Card billing address: the docs mark none of its fields as required. */
export const billingAddressSchema = z.object({
  line_1: optional(z.string().max(256)),
  line_2: optional(z.string().max(128)),
  zip_code: optional(stringish(z.string().max(16))),
  city: optional(z.string().max(64)),
  state: optional(z.string()),
  country: optional(z.string()),
});
export type BillingAddressInput = z.output<typeof billingAddressSchema>;

/**
 * Body of POST /customers/{id}/cards (docs/pagarme/reference/criar-cartao.md). Either the card data or a `token`.
 * An invalid or missing expiration is reported on the card itself: {"card": ["The card expiration date is invalid."]}.
 */
export function cardCreateSchema(now: Date) {
  return z
    .object({
      number: optional(cardNumberSchema),
      holder_name: optional(z.string().max(64)),
      holder_document: optional(z.string()),
      exp_month: optional(integerish()),
      exp_year: optional(integerish()),
      cvv: optional(cvvSchema),
      brand: optional(z.string()),
      label: optional(z.string()),
      billing_address_id: optional(z.string().max(36)),
      billing_address: optional(billingAddressSchema),
      options: optional(z.object({ verify_card: optional(z.boolean()) })),
      metadata: optional(metadataSchema),
      token: optional(z.string()),
    })
    .superRefine((card, ctx) => {
      if (card.token !== undefined) return;
      for (const field of ['number', 'holder_name', 'cvv'] as const) {
        if (card[field] === undefined) {
          ctx.addIssue({ code: 'custom', path: [field], message: `The ${field} field is required.` });
        }
      }
      if (!isExpirationValid(card.exp_month, card.exp_year, now)) {
        ctx.addIssue({ code: 'custom', path: [], message: EXPIRATION_INVALID });
      }
    });
}
export type CardCreateInput = z.output<ReturnType<typeof cardCreateSchema>>;

/** Body of PUT /customers/{id}/cards/{card_id}; the expiration error key is "card.exp_date" (editar-cartao.md). */
export function cardUpdateSchema(now: Date) {
  return z
    .object({
      holder_name: optional(z.string().max(64)),
      holder_document: optional(z.string()),
      exp_month: optional(integerish()),
      exp_year: optional(integerish()),
      billing_address_id: optional(z.string().max(36)),
      billing_address: optional(billingAddressSchema),
      metadata: optional(metadataSchema),
    })
    .superRefine((card, ctx) => {
      if (!isExpirationValid(card.exp_month, card.exp_year, now)) {
        ctx.addIssue({ code: 'custom', path: ['exp_date'], message: EXPIRATION_INVALID });
      }
    });
}
export type CardUpdateInput = z.output<ReturnType<typeof cardUpdateSchema>>;
