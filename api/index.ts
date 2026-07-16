import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from '../src/server.js';

// Vercel serverless entrypoint (Node.js runtime). vercel.json rewrites every path
// here, so this one function serves the whole gateway (GET /health, POST /v1/chat).
//
// We do NOT use `@hono/node-server/vercel`'s `handle`: Vercel's Node runtime
// pre-reads the request body (exposing it as `req.body`) and leaves the raw stream
// in a state that adapter's `c.req.json()` hangs on for every POST. Instead we
// reconstruct a Web `Request` from `req.body` and drive `app.fetch` directly, then
// stream the Web `Response` back (works for both JSON and SSE).
const app = createServer();

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = `https://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (value !== undefined) headers.set(key, value);
  }

  // Vercel has already parsed the body; serialize it back to what the app expects.
  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD' && req.body != null) {
    body =
      typeof req.body === 'string'
        ? req.body
        : Buffer.isBuffer(req.body)
          ? req.body.toString('utf8')
          : JSON.stringify(req.body);
  }

  const response = await app.fetch(new Request(url, { method, headers, body }));

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));

  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}
