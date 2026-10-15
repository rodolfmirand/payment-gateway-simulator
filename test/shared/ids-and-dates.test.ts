import { describe, expect, it } from 'vitest';
import { formatDate } from '../../src/shared/clock.js';
import { generateId, ID_PREFIX } from '../../src/shared/ids.js';

describe('generateId', () => {
  it('produces the Pagar.me format: prefix + "_" + 16 alphanumeric chars', () => {
    for (const prefix of Object.values(ID_PREFIX)) {
      expect(generateId(prefix)).toMatch(new RegExp(`^${prefix}_[A-Za-z0-9]{16}$`));
    }
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => generateId('or')));
    expect(ids.size).toBe(5000);
  });
});

describe('formatDate', () => {
  it('uses second precision with a Z suffix, like 2017-04-19T16:01:09Z', () => {
    expect(formatDate(new Date('2017-04-19T16:01:09.987Z'))).toBe('2017-04-19T16:01:09Z');
  });
});
