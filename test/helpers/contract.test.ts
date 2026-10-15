import { describe, expect, it } from 'vitest';
import { compareShape, officialExample } from './contract.js';

describe('compareShape', () => {
  it('accepts the same structure with different values', () => {
    expect(
      compareShape(
        { id: 'or_1', amount: 10, items: [{ id: 'oi_1' }] },
        { id: 'or_2', amount: 99, items: [{ id: 'oi_9' }] },
      ),
    ).toEqual([]);
  });

  it('reports missing keys and type mismatches with their path', () => {
    expect(compareShape({ id: 'x', customer: { name: 'a', phones: {} } }, { customer: { name: 1 } })).toEqual(
      ['missing $.id', '$.customer.name: expected string, got number', 'missing $.customer.phones'],
    );
  });

  it('checks array items through the first element', () => {
    expect(compareShape({ data: [{ id: 'x' }] }, { data: [{}] })).toEqual(['missing $.data[0].id']);
    expect(compareShape({ data: [{ id: 'x' }] }, { data: [] })).toEqual([]);
  });

  it('treats null in the example as any type', () => {
    expect(compareShape({ paid_at: null }, { paid_at: '2017-04-19T16:01:11Z' })).toEqual([]);
  });

  it('reports extra keys only when asked', () => {
    expect(compareShape({ a: 1 }, { a: 1, b: 2 })).toEqual([]);
    expect(compareShape({ a: 1 }, { a: 1, b: 2 }, { reportExtra: true })).toEqual(['extra $.b']);
  });
});

describe('officialExample', () => {
  it('loads response examples from docs/pagarme/openapi.json', () => {
    expect(officialExample('GET', '/customers/{customer_id}', '404')).toEqual({
      message: 'Customer not found.',
    });
  });

  it('fails loudly for unknown operations', () => {
    expect(() => officialExample('GET', '/nope', '200')).toThrow('No operation GET /nope');
  });
});
