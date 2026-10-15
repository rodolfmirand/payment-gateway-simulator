import { z } from 'zod';
import { compact, integerish, optional } from '../../shared/schemas.js';
import type { CardBrand } from '../cards/card-number.js';
import { EXPIRATION_INVALID, isExpirationValid } from '../cards/card-number.js';
import { cardNumberSchema, cvvSchema } from '../cards/schemas.js';

/** Tokens expire after 60 seconds and can be used once (docs/pagarme/reference/tokenizacao-1.md). */
export const TOKEN_TTL_SECONDS = 60;

export interface CardToken {
  id: string;
  type: 'card';
  used: boolean;
  card: {
    number: string;
    holder_name?: string;
    holder_document?: string;
    /** As sent: exp_year keeps the yy/yyyy format in the token response. */
    exp_month: number;
    exp_year: number;
    cvv?: string;
    brand: CardBrand;
    label?: string;
  };
  created_at: string;
  expires_at: string;
}

/** Body of POST /tokens (docs/pagarme/reference/criar-token-cartao-1.md). */
export function tokenCreateSchema(now: Date) {
  return z.object({
    type: z.enum(['card']),
    card: z
      .object({
        number: cardNumberSchema,
        holder_name: optional(z.string().max(64)),
        holder_document: optional(z.string()),
        exp_month: optional(integerish()),
        exp_year: optional(integerish()),
        cvv: optional(cvvSchema),
        brand: optional(z.string()),
        label: optional(z.string()),
      })
      .superRefine((card, ctx) => {
        if (!isExpirationValid(card.exp_month, card.exp_year, now)) {
          ctx.addIssue({ code: 'custom', path: [], message: EXPIRATION_INVALID });
        }
      }),
  });
}
export type TokenCreateInput = z.output<ReturnType<typeof tokenCreateSchema>>;

/** The card data in the response never includes the number or the CVV. */
export function tokenView(token: CardToken) {
  const { card } = token;
  return {
    id: token.id,
    type: token.type,
    created_at: token.created_at,
    expires_at: token.expires_at,
    card: compact({
      last_four_digits: card.number.slice(-4),
      holder_name: card.holder_name,
      holder_document: card.holder_document,
      exp_month: card.exp_month,
      exp_year: card.exp_year,
      brand: card.brand,
      label: card.label,
    }),
  };
}
