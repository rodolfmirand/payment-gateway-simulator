import { z } from 'zod';

/**
 * Optional field that also accepts null (the Pagar.me API is lenient with nulls) and normalizes it to undefined.
 */
export function optional<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((value) => value ?? undefined);
}

/** String field that also accepts a JSON number (e.g. zip_code: 20021130). */
export function stringish(schema: z.ZodString = z.string()) {
  return z.preprocess((value) => (typeof value === 'number' ? String(value) : value), schema);
}

/** Integer field that also accepts a numeric string (e.g. exp_month: "12"). */
export function integerish(schema: z.ZodNumber = z.number().int()) {
  return z.preprocess(
    (value) => (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value) ? Number(value) : value),
    schema,
  );
}

/** Key/value metadata; primitive values are stored as strings. */
export const metadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]).transform((value) => String(value)),
);
export type Metadata = z.output<typeof metadataSchema>;

const phoneSchema = z.object({
  country_code: optional(stringish()),
  area_code: optional(stringish()),
  number: optional(stringish()),
});

/** docs/pagarme/reference/telefones-1.md */
export const phonesSchema = z.object({
  home_phone: optional(phoneSchema),
  mobile_phone: optional(phoneSchema),
});
export interface Phone {
  country_code?: string;
  area_code?: string;
  number?: string;
}
export interface Phones {
  home_phone?: Phone;
  mobile_phone?: Phone;
}

/** Address fields (docs/pagarme/reference/enderecos.md). Also used as card billing address. */
export const addressInputSchema = z.object({
  line_1: z.string().max(256),
  line_2: optional(z.string().max(128)),
  zip_code: stringish(z.string().max(16)),
  city: z.string().max(64),
  state: z.string(),
  country: z.string(),
  metadata: optional(metadataSchema),
});
export type AddressInput = z.output<typeof addressInputSchema>;

/** Drops undefined values so absent fields are omitted from responses, as Pagar.me does. */
export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
