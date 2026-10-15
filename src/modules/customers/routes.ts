import { z } from 'zod';
import type { CoreModule } from '../../context.js';
import { pageQuerySchema, paginate, requestUrl } from '../../shared/pagination.js';
import { optional } from '../../shared/schemas.js';
import { parseRequest } from '../../shared/validation.js';
import { customerInputSchema } from './schemas.js';
import { CustomersService } from './service.js';

const listQuerySchema = pageQuerySchema.extend({
  name: optional(z.string()),
  document: optional(z.string()),
  email: optional(z.string()),
  gender: optional(z.string()),
  code: optional(z.string()),
});

type CustomerParams = { Params: { customer_id: string } };

/** docs/pagarme/reference/clientes-1.md */
export const customersModule: CoreModule = (app, ctx) => {
  const customers = new CustomersService(ctx);

  app.post('/customers', (request) => {
    const input = parseRequest(customerInputSchema, request.body, 'customer');
    return customers.view(customers.create(input).customer);
  });

  app.get('/customers', (request) => {
    const { page, size, ...filters } = parseRequest(listQuerySchema, request.query, '');
    const views = customers.list(filters).map((customer) => customers.view(customer));
    return paginate(views, { page, size }, requestUrl(request));
  });

  app.get<CustomerParams>('/customers/:customer_id', (request) =>
    customers.view(customers.get(request.params.customer_id)),
  );

  app.put<CustomerParams>('/customers/:customer_id', (request) => {
    const input = parseRequest(customerInputSchema, request.body, 'customer');
    return customers.view(customers.update(request.params.customer_id, input));
  });
};
