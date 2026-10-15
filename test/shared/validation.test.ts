import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../../src/shared/errors.js';
import { formatErrorKey, parseRequest } from '../../src/shared/validation.js';

function errorsOf(fn: () => unknown): Record<string, string[]> {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) return error.errors;
    throw error;
  }
  throw new Error('expected a ValidationError');
}

describe('formatErrorKey', () => {
  it('builds Pagar.me error keys', () => {
    expect(formatErrorKey('order', ['payments', 0, 'credit_card', 'card'])).toBe(
      'order.payments[0].credit_card.card',
    );
    expect(formatErrorKey('card', [])).toBe('card');
    expect(formatErrorKey('', ['next_billing_at'])).toBe('next_billing_at');
  });
});

describe('parseRequest', () => {
  const schema = z.object({
    name: z.string(),
    type: z.enum(['individual', 'company']).optional(),
    cycles: z.number().int().min(1).optional(),
    items: z.array(z.object({ amount: z.number().max(100) })).min(1),
    code: z.string().max(52).optional(),
    number: z.string({ error: 'Custom message from the schema.' }).optional(),
  });

  it('returns the parsed data when valid', () => {
    expect(parseRequest(schema, { name: 'Tony', items: [{ amount: 1 }], extra: true }, 'customer')).toEqual({
      name: 'Tony',
      items: [{ amount: 1 }],
    });
  });

  it('maps Zod issues to Pagar.me keys and messages', () => {
    const errors = errorsOf(() =>
      parseRequest(
        schema,
        { type: 'x', cycles: 0, items: [{ amount: 101 }, {}], code: 'a'.repeat(53), number: 1 },
        'customer',
      ),
    );
    expect(errors).toEqual({
      'customer.name': ['The name field is required.'],
      'customer.type': ["The type field is invalid. Possible values are 'individual' or 'company'."],
      'customer.cycles': ['The field cycles must be greater than or equal to 1'],
      'customer.items[0].amount': ['The field amount must be less than or equal to 100'],
      'customer.items[1].amount': ['The amount field is required.'],
      'customer.code': ['The field code must be a string with a maximum length of 52.'],
      'customer.number': ['Custom message from the schema.'],
    });
  });

  it('treats an empty required array as missing', () => {
    expect(errorsOf(() => parseRequest(schema, { name: 'a', items: [] }, 'order'))).toEqual({
      'order.items': ['The items field is required.'],
    });
  });

  it('echoes the original payload in the error and treats a missing body as {}', () => {
    try {
      parseRequest(schema, undefined, 'customer');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).toBody()).toEqual({
        message: 'The request is invalid.',
        errors: {
          'customer.name': ['The name field is required.'],
          'customer.items': ['The items field is required.'],
        },
        request: {},
      });
    }
  });
});
