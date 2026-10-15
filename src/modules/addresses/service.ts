import type { AppContext } from '../../context.js';
import { formatDate } from '../../shared/clock.js';
import { NotFoundError } from '../../shared/errors.js';
import { generateId } from '../../shared/ids.js';
import type { AddressInput, Metadata } from '../../shared/schemas.js';
import type { Repository } from '../../shared/store/repository.js';
import { CustomersService } from '../customers/service.js';
import { addressView, type Address } from './address.js';

export class AddressesService {
  private readonly addresses: Repository<Address>;
  private readonly customers: CustomersService;

  constructor(private readonly ctx: AppContext) {
    this.addresses = ctx.store.repository<Address>('addresses');
    this.customers = new CustomersService(ctx);
  }

  /** Creates the address row without emitting events (also used for `customer.address`). */
  insert(customerId: string, input: AddressInput): Address {
    const now = formatDate(this.ctx.clock.now());
    return this.addresses.insert({
      id: generateId('addr'),
      customer_id: customerId,
      line_1: input.line_1,
      line_2: input.line_2,
      zip_code: input.zip_code,
      city: input.city,
      state: input.state,
      country: input.country,
      status: 'active',
      metadata: input.metadata,
      created_at: now,
      updated_at: now,
    });
  }

  /** Replaces the fields of an existing address (used when a customer is updated with a new `address`). */
  overwrite(address: Address, input: AddressInput): Address {
    return this.addresses.update({
      ...address,
      ...input,
      metadata: input.metadata ?? address.metadata,
      updated_at: formatDate(this.ctx.clock.now()),
    });
  }

  findById(id: string): Address | undefined {
    return this.addresses.findById(id);
  }

  /** Address of the customer, active or deleted; 404 "Address not found." otherwise. */
  get(customerId: string, addressId: string): Address {
    const address = this.addresses.findById(addressId);
    if (address?.customer_id !== customerId) throw new NotFoundError('Address');
    return address;
  }

  create(customerId: string, input: AddressInput) {
    const customer = this.customers.get(customerId);
    const address = this.insert(customer.id, input);
    const view = this.view(address);
    this.ctx.events.emit('address.created', view);
    return view;
  }

  /** Only `line_2` and `metadata` can change (docs/pagarme/reference/editar-endereco-1.md). */
  update(customerId: string, addressId: string, input: { line_2?: string; metadata?: Metadata }) {
    this.customers.get(customerId);
    const address = this.get(customerId, addressId);
    const updated = this.addresses.update({
      ...address,
      line_2: input.line_2 ?? address.line_2,
      metadata: input.metadata ?? address.metadata,
      updated_at: formatDate(this.ctx.clock.now()),
    });
    const view = this.view(updated);
    this.ctx.events.emit('address.updated', view);
    return view;
  }

  delete(customerId: string, addressId: string) {
    this.customers.get(customerId);
    const address = this.get(customerId, addressId);
    const now = formatDate(this.ctx.clock.now());
    const deleted = this.addresses.update({
      ...address,
      status: 'deleted',
      updated_at: now,
      deleted_at: now,
    });
    const view = this.view(deleted);
    this.ctx.events.emit('address.deleted', view);
    return view;
  }

  /** Active addresses of the customer, newest first. */
  listActive(customerId: string): Address[] {
    this.customers.get(customerId);
    return this.addresses
      .findAll((address) => address.customer_id === customerId && address.status === 'active')
      .reverse();
  }

  view(address: Address) {
    return addressView(address, this.customers.embeddedView(this.customers.get(address.customer_id)));
  }
}
