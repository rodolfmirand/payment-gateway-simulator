/**
 * Rules of the official Pix and boleto simulators.
 */

/**
 * docs/pagarme/guides/simulador-pix.md: up to R$ 500,00 the Pix is created pending and paid automatically
 * seconds later; above that it is created failed.
 */
export const PIX_SUCCESS_LIMIT = 50_000;

export function pixSucceeds(amount: number): boolean {
  return amount <= PIX_SUCCESS_LIMIT;
}

export type BoletoScenario = 'paid' | 'underpaid' | 'overpaid' | 'not_conciliated';

/** docs/pagarme/guides/simulador-de-boleto.md: the customer's zip code decides how the boleto is conciliated. */
const BOLETO_ZIP_CODES: Record<string, BoletoScenario> = {
  '01046010': 'underpaid',
  '57400000': 'overpaid',
  '70070300': 'not_conciliated',
};

export function boletoScenario(customerZipCode: string | undefined): BoletoScenario {
  return BOLETO_ZIP_CODES[(customerZipCode ?? '').replace(/\D/g, '')] ?? 'paid';
}

/** The guide does not say by how much: the simulator pays 90% (underpaid) or 110% (overpaid) of the amount. */
export function boletoPaidAmount(
  scenario: Exclude<BoletoScenario, 'not_conciliated'>,
  amount: number,
): number {
  // Integer arithmetic: 3090 * 1.1 is 3399.0000000000005 in floating point.
  if (scenario === 'underpaid') return Math.max(1, Math.floor((amount * 9) / 10));
  if (scenario === 'overpaid') return Math.ceil((amount * 11) / 10);
  return amount;
}
