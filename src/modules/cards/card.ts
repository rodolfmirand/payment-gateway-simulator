import { compact, type Metadata } from '../../shared/schemas.js';
import type { CardBrand } from './card-number.js';

export interface BillingAddress {
  line_1?: string;
  line_2?: string;
  zip_code?: string;
  city?: string;
  state?: string;
  country?: string;
}

/** Stored card of a customer's wallet (docs/pagarme/reference/cartoes-1.md). */
export interface Card {
  id: string;
  customer_id: string;
  /** Full number, never rendered. Kept so payments with card_id follow the simulator card rules. */
  number: string;
  first_six_digits: string;
  last_four_digits: string;
  brand: CardBrand;
  holder_name: string;
  holder_document?: string;
  exp_month: number;
  exp_year: number;
  status: 'active' | 'deleted' | 'expired';
  type: 'credit';
  label?: string;
  is_renewed?: boolean;
  billing_address?: BillingAddress;
  metadata?: Metadata;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export function billingAddressView(address: BillingAddress) {
  return compact({
    zip_code: address.zip_code,
    city: address.city,
    state: address.state,
    country: address.country,
    line_1: address.line_1,
    line_2: address.line_2,
  });
}

/** Card as rendered by the API; `customer` is omitted in listings. */
export function cardView(card: Card, customer?: object) {
  return compact({
    id: card.id,
    first_six_digits: card.first_six_digits,
    last_four_digits: card.last_four_digits,
    brand: card.brand,
    holder_name: card.holder_name,
    holder_document: card.holder_document,
    exp_month: card.exp_month,
    exp_year: card.exp_year,
    status: card.status,
    type: card.type,
    label: card.label,
    is_renewed: card.is_renewed,
    created_at: card.created_at,
    updated_at: card.updated_at,
    deleted_at: card.deleted_at,
    billing_address: card.billing_address && billingAddressView(card.billing_address),
    customer,
    metadata: card.metadata,
  });
}
