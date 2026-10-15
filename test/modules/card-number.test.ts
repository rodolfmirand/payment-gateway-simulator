import { describe, expect, it } from 'vitest';
import {
  binInfo,
  detectBrand,
  fullYear,
  isExpirationValid,
  isLuhnValid,
  normalizeBrand,
} from '../../src/modules/cards/card-number.js';

describe('detectBrand', () => {
  it.each([
    ['4000000000000010', 'Visa'], // simulator success card
    ['4000000000000028', 'Visa'], // simulator failure card
    ['4111111111111111', 'Visa'],
    ['5425019448107793', 'Mastercard'], // official docs example
    ['2223000048400011', 'Mastercard'],
    ['378282246310005', 'Amex'],
    ['36490102462661', 'Diners'],
    ['3530111333300000', 'JCB'],
    ['6011111111111117', 'Discover'],
    ['6062825624254001', 'Hipercard'],
    ['5067224275805500', 'Elo'],
    ['4011780000000000', 'Elo'], // Elo BIN inside the Visa range
    ['5078601870000127985', 'Aura'],
  ])('%s -> %s', (number, brand) => {
    expect(detectBrand(number)).toBe(brand);
  });

  it('returns undefined for unknown BINs', () => {
    expect(detectBrand('9999999999999995')).toBeUndefined();
  });
});

describe('isLuhnValid', () => {
  it.each(['4000000000000010', '4000000000000028', '5425019448107793', '378282246310005'])(
    'accepts %s',
    (number) => {
      expect(isLuhnValid(number)).toBe(true);
    },
  );

  it.each(['4000000000000011', '1234', '4000 0000 0000 0010', ''])('rejects %j', (number) => {
    expect(isLuhnValid(number)).toBe(false);
  });
});

describe('expiration', () => {
  const now = new Date('2026-10-15T12:00:00Z');

  it('is valid through the expiration month, in yy or yyyy', () => {
    expect(isExpirationValid(10, 2026, now)).toBe(true);
    expect(isExpirationValid(10, 26, now)).toBe(true);
    expect(isExpirationValid(1, 30, now)).toBe(true);
  });

  it('is invalid when past, out of range or missing', () => {
    expect(isExpirationValid(9, 2026, now)).toBe(false);
    expect(isExpirationValid(13, 2030, now)).toBe(false);
    expect(isExpirationValid(0, 2030, now)).toBe(false);
    expect(isExpirationValid(1, undefined, now)).toBe(false);
  });

  it('expands two-digit years', () => {
    expect(fullYear(30)).toBe(2030);
    expect(fullYear(2030)).toBe(2030);
  });
});

describe('normalizeBrand', () => {
  it('maps any casing to the API name', () => {
    expect(normalizeBrand('mastercard')).toBe('Mastercard');
    expect(normalizeBrand('AMEX')).toBe('Amex');
    expect(normalizeBrand('unknown')).toBeUndefined();
    expect(normalizeBrand(undefined)).toBeUndefined();
  });
});

describe('binInfo', () => {
  it('matches the official example for Mastercard', () => {
    expect(binInfo('Mastercard')).toEqual({
      brand: 'mastercard',
      brandName: 'Mastercard',
      gaps: [4, 8, 12],
      lenghts: [16],
      mask: '/(\\d{1,4})/g',
      input: '/(?:^|s)(d{4})$/',
      cvv: 3,
    });
  });
});
