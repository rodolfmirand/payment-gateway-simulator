import type { ChargeStatus, OperationType, TransactionStatus } from './charge.js';

/**
 * Rules of the official credit card simulator (docs/pagarme/guides/simulador-de-cartao-de-credito.md):
 * the card number decides the outcome.
 */
export type CardScenario =
  | 'success'
  | 'failure'
  | 'processing_then_paid'
  | 'processing_then_failed'
  | 'cancel_processing_then_canceled'
  | 'cancel_processing_then_paid'
  | 'processing_then_canceled'
  | 'paid_then_chargedback';

const SCENARIOS: Record<string, CardScenario> = {
  '4000000000000010': 'success',
  '4000000000000028': 'failure',
  '4000000000000036': 'processing_then_paid',
  '4000000000000044': 'processing_then_failed',
  '4000000000000077': 'cancel_processing_then_canceled',
  '4000000000000093': 'cancel_processing_then_paid',
  '4000000000000051': 'processing_then_canceled',
  '4000000000000069': 'paid_then_chargedback',
};

/** "Qualquer outro cartão: qualquer transação retorna como não autorizada." */
export function scenarioFor(cardNumber: string): CardScenario {
  return SCENARIOS[cardNumber] ?? 'failure';
}

export interface Outcome {
  transaction: TransactionStatus;
  charge: ChargeStatus;
  success: boolean;
  message: string;
  returnCode?: string;
  authorized: boolean;
}

// acquirer_return_code / acquirer_message follow the ABECS codes used by API v5 since 2026-08-28
// (docs/pagarme/guides/codigos-de-retorno-padrao-abecs.md).
const CAPTURED: Outcome = {
  transaction: 'captured',
  charge: 'paid',
  success: true,
  message: 'Transação capturada com sucesso',
  returnCode: '00',
  authorized: true,
};
const AUTHORIZED: Outcome = {
  transaction: 'authorized_pending_capture',
  charge: 'pending',
  success: true,
  message: 'Transação autorizada com sucesso',
  returnCode: '00',
  authorized: true,
};
const NOT_AUTHORIZED: Outcome = {
  transaction: 'not_authorized',
  charge: 'failed',
  success: false,
  message: 'Contate a central do seu cartão',
  returnCode: '05',
  authorized: false,
};
const WITH_ERROR = (charge: ChargeStatus): Outcome => ({
  transaction: 'with_error',
  charge,
  success: false,
  message: 'Transação com erro',
  authorized: false,
});

export function approved(operation: OperationType): Outcome {
  return operation === 'auth_and_capture' ? CAPTURED : AUTHORIZED;
}

/** Status right after the authorization request. */
export function initialOutcome(scenario: CardScenario, operation: OperationType): Outcome {
  switch (scenario) {
    case 'failure':
      return NOT_AUTHORIZED;
    case 'processing_then_paid':
    case 'processing_then_failed':
      return WITH_ERROR('processing');
    case 'processing_then_canceled':
      return WITH_ERROR('pending');
    default:
      return approved(operation);
  }
}

/** Status set later by the acquirer, or undefined when nothing else happens on its own. */
export function laterOutcome(scenario: CardScenario, operation: OperationType): Outcome | undefined {
  switch (scenario) {
    case 'processing_then_paid':
      return approved(operation);
    case 'processing_then_failed':
      return {
        transaction: 'failed',
        charge: 'failed',
        success: false,
        message: 'Transação não encontrada na adquirente',
        authorized: false,
      };
    case 'processing_then_canceled':
      return {
        transaction: 'refunded',
        charge: 'canceled',
        success: true,
        message: 'Transação cancelada com sucesso',
        returnCode: '00',
        authorized: false,
      };
    case 'paid_then_chargedback':
      return operation === 'auth_and_capture'
        ? { ...CAPTURED, transaction: 'chargedback', charge: 'chargedback' }
        : undefined;
    default:
      return undefined;
  }
}
