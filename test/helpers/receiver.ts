import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

export interface ReceiverReply {
  status: number;
  body?: string;
  delayMs?: number;
}

/** Local HTTP server standing in for the merchant's webhook endpoint. `respond` gets the 1-based request number. */
export async function startReceiver(
  respond: (count: number) => ReceiverReply = () => ({ status: 200, body: 'ok' }),
) {
  const received: ReceivedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      });
      const reply = respond(received.length);
      setTimeout(() => {
        res.statusCode = reply.status;
        res.end(reply.body ?? '');
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/webhooks`,
    port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
