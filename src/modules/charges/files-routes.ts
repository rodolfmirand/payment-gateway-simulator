import type { FastifyReply } from 'fastify';
import type { CoreModule } from '../../context.js';
import { NotFoundError } from '../../shared/errors.js';
import type { BoletoTransaction } from './charge.js';
import { barcodePng, boletoPdf, qrCodePng } from './documents.js';
import { ChargesService } from './service.js';

type TransactionParams = { Params: { transaction_id: string } };

const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
const html = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char,
  );

function boletoLines(transaction: BoletoTransaction, merchant: string): string[] {
  return [
    `Boleto simulado - ${merchant}`,
    'Documento sem valor: gerado pelo simulador da API Pagar.me.',
    '',
    `Valor: ${brl(transaction.amount)}`,
    `Vencimento: ${transaction.due_at.slice(0, 10)}`,
    `Linha digitavel: ${transaction.line}`,
    `Nosso numero: ${transaction.nosso_numero}`,
    ...(transaction.instructions ? [`Instrucoes: ${transaction.instructions}`] : []),
  ];
}

/**
 * Files behind qr_code_url (Pix) and url/pdf/barcode/qr_code (boleto). Public, like on Pagar.me, so a
 * browser can show them. The content is fake: nothing can be paid with it.
 */
export const transactionFilesModule: CoreModule = (app, ctx) => {
  const charges = new ChargesService(ctx);
  const publicRoute = { config: { auth: 'none' as const } };

  const find = (id: string) => {
    const found = charges.findByTransaction(id);
    if (!found) throw new NotFoundError('Transaction');
    return found.transaction;
  };
  const boleto = (id: string): BoletoTransaction => {
    const transaction = find(id);
    if (transaction.transaction_type !== 'boleto') throw new NotFoundError('Transaction');
    return transaction;
  };
  const sendPng = (reply: FastifyReply, image: Buffer) => reply.type('image/png').send(image);

  app.get<TransactionParams>('/transactions/:transaction_id/qrcode', publicRoute, (request, reply) => {
    const transaction = find(request.params.transaction_id);
    const seed =
      transaction.transaction_type === 'pix'
        ? transaction.qr_code
        : transaction.transaction_type === 'boleto'
          ? transaction.line
          : undefined;
    if (seed === undefined) throw new NotFoundError('Transaction');
    return sendPng(reply, qrCodePng(seed));
  });

  app.get<TransactionParams>('/transactions/:transaction_id/barcode', publicRoute, (request, reply) =>
    sendPng(reply, barcodePng(boleto(request.params.transaction_id).line)),
  );

  app.get<TransactionParams>('/transactions/:transaction_id/pdf', publicRoute, (request, reply) => {
    const transaction = boleto(request.params.transaction_id);
    return reply
      .type('application/pdf')
      .header('content-disposition', `inline; filename="boleto-${transaction.id}.pdf"`)
      .send(boletoPdf(boletoLines(transaction, ctx.config.account.name)));
  });

  app.get<TransactionParams>('/transactions/:transaction_id/boleto', publicRoute, (request, reply) => {
    const transaction = boleto(request.params.transaction_id);
    const [title = '', ...rest] = boletoLines(transaction, ctx.config.account.name);
    const page = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${html(title)}</title></head>
<body style="font-family:sans-serif;max-width:720px;margin:2rem auto">
<h1>${html(title)}</h1>${rest.map((line) => `<p>${html(line)}</p>`).join('')}
<img alt="Código de barras" src="${html(transaction.barcode)}" style="width:100%;image-rendering:pixelated">
<p><a href="${html(transaction.pdf)}">PDF</a></p></body></html>`;
    return reply.type('text/html; charset=utf-8').send(page);
  });
};
