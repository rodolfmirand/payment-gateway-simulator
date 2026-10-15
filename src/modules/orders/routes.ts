import type { CoreModule } from '../../context.js';
import { baseUrl, paginate, requestUrl } from '../../shared/pagination.js';
import { parseRequest } from '../../shared/validation.js';
import {
  itemInputSchema,
  itemUpdateSchema,
  orderCloseSchema,
  orderCreateSchema,
  orderListQuerySchema,
} from './schemas.js';
import { OrdersService } from './service.js';

type OrderParams = { Params: { order_id: string } };
type ItemParams = { Params: { order_id: string; item_id: string } };

/** docs/pagarme/reference/pedidos-1.md and item-do-pedido-1.md */
export const ordersModule: CoreModule = (app, ctx) => {
  const orders = new OrdersService(ctx);

  app.post('/orders', (request) => {
    const input = parseRequest(orderCreateSchema(ctx.clock.now()), request.body, 'order');
    return orders.create(input, request.body, baseUrl(request));
  });

  app.get('/orders', (request) => {
    const { page, size, ...filters } = parseRequest(orderListQuerySchema, request.query, '');
    const views = orders.list(filters).map((order) => orders.view(order));
    return paginate(views, { page, size }, requestUrl(request));
  });

  app.get<OrderParams>('/orders/:order_id', (request) => orders.view(orders.get(request.params.order_id)));

  app.patch<OrderParams>('/orders/:order_id/closed', (request) => {
    const { status } = parseRequest(orderCloseSchema, request.body, 'order');
    return orders.close(request.params.order_id, status);
  });

  app.post<OrderParams>('/orders/:order_id/items', (request) => {
    const input = parseRequest(itemInputSchema, request.body, 'item');
    return orders.addItem(request.params.order_id, input);
  });

  app.delete<OrderParams>('/orders/:order_id/items', (request) =>
    orders.deleteAllItems(request.params.order_id),
  );

  app.get<ItemParams>('/orders/:order_id/items/:item_id', (request) =>
    orders.getItem(request.params.order_id, request.params.item_id),
  );

  app.put<ItemParams>('/orders/:order_id/items/:item_id', (request) => {
    const input = parseRequest(itemUpdateSchema, request.body, 'item');
    return orders.updateItem(request.params.order_id, request.params.item_id, input);
  });

  app.delete<ItemParams>('/orders/:order_id/items/:item_id', (request) =>
    orders.deleteItem(request.params.order_id, request.params.item_id),
  );
};
