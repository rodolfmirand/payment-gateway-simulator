import { compact, type Metadata, type Phones } from '../../shared/schemas.js';
import type { Address } from '../addresses/address.js';
import { addressSummaryView } from '../addresses/address.js';

/** Stored customer (docs/pagarme/reference/clientes-1.md). */
export interface Customer {
  id: string;
  name: string;
  email?: string;
  code?: string;
  document?: string;
  document_type?: string;
  type?: string;
  gender?: string;
  birthdate?: string;
  phones: Phones;
  metadata?: Metadata;
  delinquent: boolean;
  /** Main address, created from `customer.address`. */
  address_id?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Customer as rendered by the API. `address` is included when the customer has an active main address;
 * customers embedded in other resources (address, card) are rendered without it.
 */
export function customerView(customer: Customer, address?: Address) {
  return compact({
    id: customer.id,
    name: customer.name,
    email: customer.email,
    code: customer.code,
    document: customer.document,
    document_type: customer.document_type,
    type: customer.type,
    gender: customer.gender,
    delinquent: customer.delinquent,
    address: address && address.status === 'active' ? addressSummaryView(address) : undefined,
    created_at: customer.created_at,
    updated_at: customer.updated_at,
    birthdate: customer.birthdate,
    phones: customer.phones,
    metadata: customer.metadata,
  });
}
