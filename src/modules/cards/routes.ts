import type { CoreModule } from '../../context.js';
import { pageQuerySchema, paginate, requestUrl } from '../../shared/pagination.js';
import { parseRequest } from '../../shared/validation.js';
import { cardView } from './card.js';
import { cardCreateSchema, cardUpdateSchema } from './schemas.js';
import { CardsService } from './service.js';

type CustomerParams = { Params: { customer_id: string } };
type CardParams = { Params: { customer_id: string; card_id: string } };

/** docs/pagarme/reference/cartoes-1.md */
export const cardsModule: CoreModule = (app, ctx) => {
  const cards = new CardsService(ctx);

  app.post<CustomerParams>('/customers/:customer_id/cards', (request) => {
    const input = parseRequest(cardCreateSchema(ctx.clock.now()), request.body, 'card');
    return cards.create(request.params.customer_id, input, request.body);
  });

  app.get<CustomerParams>('/customers/:customer_id/cards', (request) => {
    const query = parseRequest(pageQuerySchema, request.query, '');
    const views = cards.listActive(request.params.customer_id).map((card) => cardView(card));
    return paginate(views, query, requestUrl(request));
  });

  app.get<CardParams>('/customers/:customer_id/cards/:card_id', (request) =>
    cards.view(cards.get(request.params.customer_id, request.params.card_id)),
  );

  app.put<CardParams>('/customers/:customer_id/cards/:card_id', (request) => {
    const input = parseRequest(cardUpdateSchema(ctx.clock.now()), request.body, 'card');
    return cards.update(request.params.customer_id, request.params.card_id, input);
  });

  app.delete<CardParams>('/customers/:customer_id/cards/:card_id', (request) =>
    cards.delete(request.params.customer_id, request.params.card_id),
  );

  app.post<CardParams>('/customers/:customer_id/cards/:card_id/renew', (request) =>
    cards.renew(request.params.customer_id, request.params.card_id),
  );
};
