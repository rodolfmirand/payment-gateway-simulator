import { z } from 'zod';
import { addressInputSchema, metadataSchema, optional, phonesSchema } from '../../shared/schemas.js';

/** Accepts 1984-05-03, 1984-05-03T00:00:00Z or 05/03/1984 (mm/dd/yyyy) and renders 1984-05-03T00:00:00Z. */
export function parseBirthdate(value: string): string | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const [year, month, day] = iso ? [iso[1], iso[2], iso[3]] : us ? [us[3], us[1], us[2]] : [];
  if (!year || !month || !day) return undefined;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return undefined;
  return `${year}-${month}-${day}T00:00:00Z`;
}

const birthdateSchema = z.string().transform((value, ctx) => {
  const parsed = parseBirthdate(value);
  if (!parsed) {
    ctx.addIssue({ code: 'custom', message: 'The birthdate field is invalid.' });
    return z.NEVER;
  }
  return parsed;
});

/** Body of POST /customers and PUT /customers/{id} (docs/pagarme/reference/criar-cliente-1.md). */
export const customerInputSchema = z
  .object({
    name: z.string().max(64),
    email: optional(z.email().max(64)),
    code: optional(z.string().max(52)),
    document: optional(z.string().max(50)),
    document_type: optional(z.string()),
    // The official boleto example sends "Individual"; responses always carry it lowercase.
    type: optional(
      z.preprocess(
        (value) => (typeof value === 'string' ? value.toLowerCase() : value),
        z.enum(['individual', 'company']),
      ),
    ),
    gender: optional(z.string()),
    address: optional(addressInputSchema),
    phones: optional(phonesSchema),
    birthdate: optional(birthdateSchema),
    metadata: optional(metadataSchema),
  })
  .superRefine((customer, ctx) => {
    // "type: Obrigatório, caso o document seja enviado."
    if (customer.document !== undefined && customer.type === undefined) {
      ctx.addIssue({ code: 'custom', path: ['type'], message: 'The type field is required.' });
    }
  });

export type CustomerInput = z.output<typeof customerInputSchema>;
