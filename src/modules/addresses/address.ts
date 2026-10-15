import { compact, type Metadata } from '../../shared/schemas.js';

/** Stored address of a customer (docs/pagarme/reference/enderecos.md). */
export interface Address {
  id: string;
  customer_id: string;
  line_1: string;
  line_2?: string;
  zip_code: string;
  city: string;
  state: string;
  country: string;
  status: 'active' | 'deleted';
  metadata?: Metadata;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

/** Address without the customer: used in listings and inside the customer. */
export function addressSummaryView(address: Address) {
  return compact({
    id: address.id,
    line_1: address.line_1,
    line_2: address.line_2,
    zip_code: address.zip_code,
    city: address.city,
    state: address.state,
    country: address.country,
    status: address.status,
    created_at: address.created_at,
    updated_at: address.updated_at,
    deleted_at: address.deleted_at,
    metadata: address.metadata,
  });
}

/** Address with the embedded customer: used by get/create/update/delete. */
export function addressView(address: Address, customer: object) {
  const { metadata, ...summary } = addressSummaryView(address);
  return compact({ ...summary, customer, metadata });
}
