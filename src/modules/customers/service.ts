import type { AppContext } from '../../context.js';
import { formatDate } from '../../shared/clock.js';
import { NotFoundError } from '../../shared/errors.js';
import { generateId } from '../../shared/ids.js';
import { compact } from '../../shared/schemas.js';
import type { Repository } from '../../shared/store/repository.js';
import type { Address } from '../addresses/address.js';
import { AddressesService } from '../addresses/service.js';
import { customerView, type Customer } from './customer.js';
import type { CustomerInput } from './schemas.js';

export interface CustomerFilters {
  name?: string;
  document?: string;
  email?: string;
  gender?: string;
  code?: string;
}

export class CustomersService {
  private readonly customers: Repository<Customer>;

  constructor(private readonly ctx: AppContext) {
    this.customers = ctx.store.repository<Customer>('customers');
  }

  /** 404 "Customer not found." when missing. */
  get(id: string): Customer {
    const customer = this.customers.findById(id);
    if (!customer) throw new NotFoundError('Customer');
    return customer;
  }

  findByEmail(email: string): Customer | undefined {
    return this.customers.findAll((customer) => customer.email === email)[0];
  }

  /**
   * POST /customers. The e-mail is a unique key (docs/pagarme/guides/carteira-de-clientes.md):
   * sending the e-mail of an existing customer updates and returns that customer.
   */
  create(input: CustomerInput): { customer: Customer; created: boolean } {
    const existing = input.email ? this.findByEmail(input.email) : undefined;
    if (existing) return { customer: this.update(existing.id, input), created: false };

    const now = formatDate(this.ctx.clock.now());
    const id = generateId('cus');
    const address = input.address ? this.addresses().insert(id, input.address) : undefined;
    const customer = this.customers.insert(
      compact({
        id,
        name: input.name,
        email: input.email,
        code: input.code,
        document: input.document,
        document_type: input.document_type,
        type: input.type,
        gender: input.gender,
        birthdate: input.birthdate,
        phones: compact(input.phones ?? {}),
        metadata: input.metadata,
        delinquent: false,
        address_id: address?.id,
        created_at: now,
        updated_at: now,
      }),
    );
    this.ctx.events.emit('customer.created', this.view(customer));
    return { customer, created: true };
  }

  /** PUT /customers/{id}: fields sent replace the stored ones; fields not sent are kept. */
  update(id: string, input: CustomerInput): Customer {
    const current = this.get(id);
    const addresses = this.addresses();
    let addressId = current.address_id;
    if (input.address) {
      const main = addressId ? addresses.findById(addressId) : undefined;
      addressId =
        main?.status === 'active'
          ? addresses.overwrite(main, input.address).id
          : addresses.insert(id, input.address).id;
    }
    const updated = this.customers.update(
      compact({
        ...current,
        name: input.name,
        email: input.email ?? current.email,
        code: input.code ?? current.code,
        document: input.document ?? current.document,
        document_type: input.document_type ?? current.document_type,
        type: input.type ?? current.type,
        gender: input.gender ?? current.gender,
        birthdate: input.birthdate ?? current.birthdate,
        phones: input.phones ? compact(input.phones) : current.phones,
        metadata: input.metadata ?? current.metadata,
        address_id: addressId,
        updated_at: formatDate(this.ctx.clock.now()),
      }),
    );
    this.ctx.events.emit('customer.updated', this.view(updated));
    return updated;
  }

  /** Newest first, exact match on every filter sent. */
  list(filters: CustomerFilters): Customer[] {
    const active = Object.entries(filters).filter(([, value]) => value !== undefined);
    return this.customers
      .findAll((customer) => active.every(([key, value]) => customer[key as keyof CustomerFilters] === value))
      .reverse();
  }

  view(customer: Customer) {
    const address: Address | undefined = customer.address_id
      ? this.addresses().findById(customer.address_id)
      : undefined;
    return customerView(customer, address);
  }

  /** Customer embedded in other resources (address, card): never includes the address. */
  embeddedView(customer: Customer) {
    return customerView(customer);
  }

  // Resolved lazily: AddressesService also depends on this service.
  private addresses(): AddressesService {
    return new AddressesService(this.ctx);
  }
}
