import { z } from 'zod';

/** `page` + `size` pagination (docs/pagarme/reference/paginacao-1.md) */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).default(10),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Paging {
  total: number;
  previous?: string;
  next?: string;
}

export interface Page<T> {
  data: T[];
  paging: Paging;
}

function withPage(url: URL, page: number): string {
  const target = new URL(url);
  target.searchParams.set('page', String(page));
  return target.toString();
}

/**
 * Slices `items` and builds the "paging" object. `previous`/`next` are absolute URLs to the same
 * endpoint (keeping the other query params) and are omitted when there is no such page.
 */
export function paginate<T>(items: readonly T[], { page, size }: PageQuery, requestUrl: URL): Page<T> {
  const start = (page - 1) * size;
  const paging: Paging = { total: items.length };
  if (page > 1) paging.previous = withPage(requestUrl, page - 1);
  if (start + size < items.length) paging.next = withPage(requestUrl, page + 1);
  return { data: items.slice(start, start + size), paging };
}
