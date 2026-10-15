/** Card number rules shared by cards, tokens and (later) order payments. */

export type CardBrand =
  'Visa' | 'Mastercard' | 'Amex' | 'Elo' | 'Hipercard' | 'Diners' | 'Discover' | 'JCB' | 'Aura';

export const CARD_BRANDS: readonly CardBrand[] = [
  'Visa',
  'Mastercard',
  'Amex',
  'Elo',
  'Hipercard',
  'Diners',
  'Discover',
  'JCB',
  'Aura',
];

export function isLuhnValid(number: string): boolean {
  if (!/^\d+$/.test(number)) return false;
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let digit = Number(number[number.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const inRange = (bin: number, from: number, to: number) => bin >= from && bin <= to;

const ELO_BINS = new Set([
  401178, 401179, 431274, 438935, 451416, 457393, 457631, 457632, 504175, 627780, 636297, 636368,
]);
const ELO_RANGES: [number, number][] = [
  [506699, 506778],
  [509000, 509999],
  [650031, 650033],
  [650035, 650051],
  [650405, 650439],
  [650485, 650538],
  [650541, 650598],
  [650700, 650718],
  [650720, 650727],
  [650901, 650920],
  [651652, 651679],
  [655000, 655019],
  [655021, 655058],
];
const HIPERCARD_BINS = new Set([606282, 637095, 637568, 637599, 637609, 637612]);

/** Brand from the BIN (first digits). Elo and Hipercard are checked first: their BINs overlap Visa/Discover/Diners. */
export function detectBrand(number: string): CardBrand | undefined {
  const bin = Number(number.slice(0, 6));
  if (ELO_BINS.has(bin) || ELO_RANGES.some(([from, to]) => inRange(bin, from, to))) return 'Elo';
  if (HIPERCARD_BINS.has(bin) || /^3841[046]0/.test(number)) return 'Hipercard';
  if (/^3[47]/.test(number)) return 'Amex';
  if (/^3(0[0-59]|[68])/.test(number)) return 'Diners';
  if (inRange(Number(number.slice(0, 4)), 3528, 3589)) return 'JCB';
  if (/^(6011|64[4-9]|65)/.test(number) || inRange(bin, 622126, 622925)) return 'Discover';
  if (/^50/.test(number)) return 'Aura';
  const two = Number(number.slice(0, 2));
  const four = Number(number.slice(0, 4));
  if (inRange(two, 51, 55) || inRange(four, 2221, 2720)) return 'Mastercard';
  if (number.startsWith('4')) return 'Visa';
  return undefined;
}

/** Normalizes a brand sent by the client ("visa", "MASTERCARD"...) to the name the API returns. */
export function normalizeBrand(brand: string | undefined): CardBrand | undefined {
  return CARD_BRANDS.find((known) => known.toLowerCase() === brand?.toLowerCase());
}

/** exp_year accepts yy or yyyy (docs/pagarme/reference/cartoes-1.md). */
export function fullYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

/** A card is valid through the last day of its expiration month. */
export function isExpirationValid(month: number | undefined, year: number | undefined, now: Date): boolean {
  if (month === undefined || year === undefined || month < 1 || month > 12) return false;
  const current = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return fullYear(year) * 12 + (month - 1) >= current;
}

export const EXPIRATION_INVALID = 'The card expiration date is invalid.';
export const NUMBER_INVALID = 'The number field is not a valid credit card number.';
export const NUMBER_LENGTH =
  'The field number must be a string with a minimum length of 13 and a maximum length of 19.';

/** Data of GET /bin/v1/{bin} (docs/pagarme/reference/bin.md). "lenghts" is spelled as in the API. */
export function binInfo(brand: CardBrand) {
  const amex = brand === 'Amex';
  const diners = brand === 'Diners';
  return {
    brand: brand.toLowerCase(),
    brandName: brand,
    gaps: amex || diners ? [4, 10] : [4, 8, 12],
    lenghts: amex ? [15] : diners ? [14] : [16],
    mask: '/(\\d{1,4})/g',
    input: '/(?:^|s)(d{4})$/',
    cvv: amex ? 4 : 3,
  };
}
