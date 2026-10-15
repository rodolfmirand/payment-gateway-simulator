import { z } from 'zod';
import type { CoreModule } from '../../context.js';
import { pageQuerySchema, paginate, requestUrl } from '../../shared/pagination.js';
import { addressInputSchema, metadataSchema, optional } from '../../shared/schemas.js';
import { parseRequest } from '../../shared/validation.js';
import { addressSummaryView } from './address.js';
import { AddressesService } from './service.js';

const addressUpdateSchema = z.object({
  line_2: optional(z.string().max(128)),
  metadata: optional(metadataSchema),
});

type CustomerParams = { Params: { customer_id: string } };
type AddressParams = { Params: { customer_id: string; address_id: string } };

/** docs/pagarme/reference/enderecos.md */
export const addressesModule: CoreModule = (app, ctx) => {
  const addresses = new AddressesService(ctx);

  app.post<CustomerParams>('/customers/:customer_id/addresses', (request) => {
    const input = parseRequest(addressInputSchema, request.body, 'address');
    return addresses.create(request.params.customer_id, input);
  });

  app.get<CustomerParams>('/customers/:customer_id/addresses', (request) => {
    const query = parseRequest(pageQuerySchema, request.query, '');
    const views = addresses.listActive(request.params.customer_id).map(addressSummaryView);
    return paginate(views, query, requestUrl(request));
  });

  app.get<AddressParams>('/customers/:customer_id/addresses/:address_id', (request) => {
    const { customer_id, address_id } = request.params;
    return addresses.view(addresses.get(customer_id, address_id));
  });

  app.put<AddressParams>('/customers/:customer_id/addresses/:address_id', (request) => {
    const input = parseRequest(addressUpdateSchema, request.body, 'address');
    return addresses.update(request.params.customer_id, request.params.address_id, input);
  });

  app.delete<AddressParams>('/customers/:customer_id/addresses/:address_id', (request) =>
    addresses.delete(request.params.customer_id, request.params.address_id),
  );
};
