import type { AppContext } from '../../context.js';
import { formatDate } from '../../shared/clock.js';
import { ValidationError } from '../../shared/errors.js';
import { generateId } from '../../shared/ids.js';
import type { Repository } from '../../shared/store/repository.js';
import { NUMBER_INVALID, detectBrand, normalizeBrand } from '../cards/card-number.js';
import { TOKEN_TTL_SECONDS, type CardToken, type TokenCreateInput } from './token.js';

export class TokensService {
  private readonly tokens: Repository<CardToken>;

  constructor(private readonly ctx: AppContext) {
    this.tokens = ctx.store.repository<CardToken>('tokens');
  }

  create(input: TokenCreateInput, body: unknown): CardToken {
    const { card } = input;
    const brand = detectBrand(card.number) ?? normalizeBrand(card.brand);
    if (!brand || card.exp_month === undefined || card.exp_year === undefined) {
      throw new ValidationError({ 'card.number': [NUMBER_INVALID] }, body);
    }
    const now = this.ctx.clock.now();
    return this.tokens.insert({
      id: generateId('token'),
      type: 'card',
      used: false,
      card: {
        number: card.number,
        holder_name: card.holder_name,
        holder_document: card.holder_document,
        exp_month: card.exp_month,
        exp_year: card.exp_year,
        cvv: card.cvv,
        brand,
        label: card.label,
      },
      created_at: formatDate(now),
      expires_at: formatDate(new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000)),
    });
  }

  /** Returns the token and marks it as used, or undefined if it does not exist, expired or was already used. */
  consume(id: string): CardToken | undefined {
    const token = this.tokens.findById(id);
    if (!token || token.used || this.ctx.clock.now() > new Date(token.expires_at)) return undefined;
    return this.tokens.update({ ...token, used: true });
  }
}
