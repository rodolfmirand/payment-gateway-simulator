import { describe, expect, it } from 'vitest';
import { pageQuerySchema, paginate } from '../../src/shared/pagination.js';
import { compareShape, officialExample } from '../helpers/contract.js';

const items = Array.from({ length: 5 }, (_, i) => ({ id: `item_${i + 1}` }));
const url = new URL('http://localhost:4000/core/v5/orders?status=paid&size=2');

describe('paginate', () => {
  it('returns the first page with "next" only', () => {
    expect(paginate(items, { page: 1, size: 2 }, url)).toEqual({
      data: [{ id: 'item_1' }, { id: 'item_2' }],
      paging: { total: 5, next: 'http://localhost:4000/core/v5/orders?status=paid&size=2&page=2' },
    });
  });

  it('returns "previous" and "next" in the middle and keeps the other query params', () => {
    const middle = new URL('http://localhost:4000/core/v5/orders?status=paid&size=2&page=2');
    expect(paginate(items, { page: 2, size: 2 }, middle).paging).toEqual({
      total: 5,
      previous: 'http://localhost:4000/core/v5/orders?status=paid&size=2&page=1',
      next: 'http://localhost:4000/core/v5/orders?status=paid&size=2&page=3',
    });
  });

  it('returns only "total" when everything fits in one page', () => {
    expect(paginate(items, { page: 1, size: 10 }, url).paging).toEqual({ total: 5 });
  });

  it('returns an empty page past the end', () => {
    expect(paginate(items, { page: 9, size: 2 }, url).data).toEqual([]);
  });

  it('has the same shape as the official list example', () => {
    const example = officialExample('GET', '/orders', '200') as { paging: unknown };
    expect(compareShape(example.paging, paginate(items, { page: 1, size: 2 }, url).paging)).toEqual([]);
  });
});

describe('pageQuerySchema', () => {
  it('defaults to page 1, size 10 and coerces query strings', () => {
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, size: 10 });
    expect(pageQuerySchema.parse({ page: '3', size: '50' })).toEqual({ page: 3, size: 50 });
  });
});
