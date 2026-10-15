import type { AppContext } from '../../context.js';
import { formatDate } from '../../shared/clock.js';
import { NotFoundError, PreconditionFailedError, ValidationError } from '../../shared/errors.js';
import { generateId } from '../../shared/ids.js';
import { compact, type Metadata } from '../../shared/schemas.js';
import type { Repository } from '../../shared/store/repository.js';
import { AddressesService } from '../addresses/service.js';
import { CustomersService } from '../customers/service.js';
import { TokensService } from '../tokens/service.js';
import { NUMBER_INVALID, detectBrand, fullYear, normalizeBrand, type CardBrand } from './card-number.js';
import { cardView, type BillingAddress, type Card } from './card.js';
import type { BillingAddressInput, CardCreateInput, CardUpdateInput } from './schemas.js';

export interface NewCard {
  number: string;
  brand: CardBrand;
  holder_name: string;
  holder_document?: string;
  exp_month: number;
  /** yy or yyyy */
  exp_year: number;
  label?: string;
  billing_address?: BillingAddress;
  metadata?: Metadata;
}

export class CardsService {
  private readonly cards: Repository<Card>;
  private readonly customers: CustomersService;
  private readonly addresses: AddressesService;
  private readonly tokens: TokensService;

  constructor(private readonly ctx: AppContext) {
    this.cards = ctx.store.repository<Card>('cards');
    this.customers = new CustomersService(ctx);
    this.addresses = new AddressesService(ctx);
    this.tokens = new TokensService(ctx);
  }

  /** POST /customers/{id}/cards. `body` is echoed back in validation errors. */
  create(customerId: string, input: CardCreateInput, body: unknown) {
    const customer = this.customers.get(customerId);
    const data = input.token === undefined ? input : this.fromToken(input.token, body);
    const { number, holder_name, exp_month, exp_year } = data;
    const brand = number ? (detectBrand(number) ?? normalizeBrand(data.brand)) : undefined;
    if (!number || !holder_name || exp_month === undefined || exp_year === undefined || !brand) {
      throw new ValidationError({ 'card.number': [NUMBER_INVALID] }, body);
    }

    const card = this.insert(customer.id, {
      number,
      brand,
      holder_name,
      holder_document: data.holder_document,
      exp_month,
      exp_year,
      label: input.label ?? data.label,
      billing_address: this.billingAddress(customer.id, input.billing_address_id, input.billing_address),
      metadata: input.metadata,
    });
    const view = this.view(card);
    this.ctx.events.emit('card.created', view);
    return view;
  }

  /** Stores a card in the customer's wallet without emitting events (also used by payments with `card`). */
  insert(customerId: string, data: NewCard): Card {
    const now = formatDate(this.ctx.clock.now());
    return this.cards.insert(
      compact({
        id: generateId('card'),
        customer_id: customerId,
        number: data.number,
        first_six_digits: data.number.slice(0, 6),
        last_four_digits: data.number.slice(-4),
        brand: data.brand,
        holder_name: data.holder_name,
        holder_document: data.holder_document,
        exp_month: data.exp_month,
        exp_year: fullYear(data.exp_year),
        status: 'active' as const,
        type: 'credit' as const,
        label: data.label,
        billing_address: data.billing_address,
        metadata: data.metadata,
        created_at: now,
        updated_at: now,
      }),
    );
  }

  /** Card by id, any customer. */
  findById(cardId: string): Card | undefined {
    return this.cards.findById(cardId);
  }

  /** Card of the customer (any status); 404 "Customer not found." / "Card not found.". */
  get(customerId: string, cardId: string): Card {
    this.customers.get(customerId);
    const card = this.cards.findById(cardId);
    if (card?.customer_id !== customerId) throw new NotFoundError('Card');
    return card;
  }

  /** Active cards of the customer, newest first. */
  listActive(customerId: string): Card[] {
    this.customers.get(customerId);
    return this.cards
      .findAll((card) => card.customer_id === customerId && card.status === 'active')
      .reverse();
  }

  update(customerId: string, cardId: string, input: CardUpdateInput) {
    const card = this.get(customerId, cardId);
    const updated = this.cards.update(
      compact({
        ...card,
        holder_name: input.holder_name ?? card.holder_name,
        holder_document: input.holder_document ?? card.holder_document,
        exp_month: input.exp_month ?? card.exp_month,
        exp_year: input.exp_year === undefined ? card.exp_year : fullYear(input.exp_year),
        billing_address:
          this.billingAddress(customerId, input.billing_address_id, input.billing_address) ??
          card.billing_address,
        metadata: input.metadata ?? card.metadata,
        updated_at: formatDate(this.ctx.clock.now()),
      }),
    );
    const view = this.view(updated);
    this.ctx.events.emit('card.updated', view);
    return view;
  }

  delete(customerId: string, cardId: string) {
    const card = this.get(customerId, cardId);
    if (card.status === 'deleted') return this.view(card);
    const now = formatDate(this.ctx.clock.now());
    const deleted = this.cards.update({ ...card, status: 'deleted', updated_at: now, deleted_at: now });
    const view = this.view(deleted);
    this.ctx.events.emit('card.deleted', view);
    return view;
  }

  /** Card Updater, manual mode (renovar-cartao-1.md). Only active cards can be renewed. */
  renew(customerId: string, cardId: string) {
    const card = this.get(customerId, cardId);
    if (card.status !== 'active') throw new PreconditionFailedError('Could not renew card.');
    const renewed = this.cards.update({
      ...card,
      is_renewed: true,
      updated_at: formatDate(this.ctx.clock.now()),
    });
    return this.view(renewed);
  }

  view(card: Card) {
    return cardView(card, this.customers.embeddedView(this.customers.get(card.customer_id)));
  }

  private fromToken(tokenId: string, body: unknown) {
    const token = this.tokens.consume(tokenId);
    if (!token) throw new ValidationError({ 'card.token': ['The token is invalid or expired.'] }, body);
    return token.card;
  }

  /** `billing_address_id` copies an address of the customer's wallet; otherwise the address sent is used. */
  billingAddress(
    customerId: string,
    addressId: string | undefined,
    address: BillingAddressInput | undefined,
  ): BillingAddress | undefined {
    if (addressId !== undefined) {
      const { line_1, line_2, zip_code, city, state, country } = this.addresses.get(customerId, addressId);
      return compact({ line_1, line_2, zip_code, city, state, country });
    }
    return address && compact(address);
  }
}
