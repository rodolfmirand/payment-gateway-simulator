import { getRandomValues } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 16;

/** Prefixes used by Pagar.me ids, e.g. or_28dN9w7CLU79kDjL */
export const ID_PREFIX = {
  account: 'acc',
  address: 'addr',
  card: 'card',
  charge: 'ch',
  customer: 'cus',
  hook: 'hook',
  order: 'or',
  orderItem: 'oi',
  token: 'token',
  transaction: 'tran',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

export function randomString(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of getRandomValues(new Uint8Array(length * 2))) {
      const index = byte & 63; // 0..63, rejecting 62 and 63 keeps the distribution uniform
      if (index < ALPHABET.length) out += ALPHABET.charAt(index);
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateId(prefix: IdPrefix): string {
  return `${prefix}_${randomString(ID_LENGTH)}`;
}
