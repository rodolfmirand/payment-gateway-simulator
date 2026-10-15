import { z } from 'zod';
import type { CoreModule } from '../../context.js';
import { RawResponseError } from '../../shared/errors.js';
import { pageQuerySchema, paginate, requestUrl } from '../../shared/pagination.js';
import { optional } from '../../shared/schemas.js';
import type { Repository } from '../../shared/store/repository.js';
import { parseRequest } from '../../shared/validation.js';
import { hookView, type Hook } from './hook.js';

const dateFilter = z.string().refine((value) => !Number.isNaN(Date.parse(value)));

const listQuerySchema = pageQuerySchema.extend({
  status: optional(z.enum(['pending', 'sent', 'failed'])),
  webhook_event: optional(z.string()),
  created_since: optional(dateFilter),
  created_until: optional(dateFilter),
});

type HookParams = { Params: { hook_id: string } };

/** The docs only show `400 {}` as the error of these endpoints, including for unknown hooks. */
const hookNotFound = () => new RawResponseError(400, {});

/** docs/pagarme/reference/listar-webhooks.md, obter-webhook.md, enviar-webhook.md */
export const webhooksModule: CoreModule = (app, ctx) => {
  const hooks: Repository<Hook> = ctx.store.repository<Hook>('hooks');
  const view = (hook: Hook) => hookView(hook, ctx.config.account);

  app.get('/hooks', (request) => {
    const { page, size, status, webhook_event, created_since, created_until } = parseRequest(
      listQuerySchema,
      request.query,
      '',
    );
    const since = created_since === undefined ? undefined : Date.parse(created_since);
    const until = created_until === undefined ? undefined : Date.parse(created_until);
    const found = hooks
      .findAll((hook) => {
        const created = Date.parse(hook.created_at);
        return (
          (status === undefined || hook.status === status) &&
          (webhook_event === undefined || hook.event === webhook_event) &&
          (since === undefined || created >= since) &&
          (until === undefined || created <= until)
        );
      })
      .reverse();
    return paginate(found.map(view), { page, size }, requestUrl(request));
  });

  app.get<HookParams>('/hooks/:hook_id', (request) => {
    const hook = hooks.findById(request.params.hook_id);
    if (!hook) throw hookNotFound();
    return view(hook);
  });

  app.post<HookParams>('/hooks/:hook_id/retry', async (request) => {
    if (!hooks.findById(request.params.hook_id)) throw hookNotFound();
    await ctx.webhooks.retry(request.params.hook_id);
    return {};
  });
};
