import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Hono } from 'hono';
import { createServer } from '../src/server.js';

// Vercel serverless entrypoint (Node.js runtime). vercel.json rewrites every path
// here, so this one function serves the whole gateway (GET /health, POST /v1/chat).
//
// We do NOT use `@hono/node-server/vercel`'s `handle`: Vercel's Node runtime
// pre-reads the request body (exposing it as `req.body`) and leaves the raw stream
// in a state that adapter's `c.req.json()` hangs on for every POST. Instead we
// reconstruct a Web `Request` from `req.body` and drive `app.fetch` directly, then
// stream the Web `Response` back (works for both JSON and SSE).

/**
 * Adapt a Hono app to a Node `(req, res)` handler. Exported (not just the default)
 * so the body reconstruction and, crucially, the client-disconnect cancellation can
 * be unit-tested without a live server.
 */
export function toNodeHandler(app: Pick<Hono, 'fetch'>) {
  return async function handler(
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
      // Client disconnect -> cancel the response stream. Hono's streamSSE turns a
      // cancel of its readable into an `abort()` (Node has no request-signal path),
      // which fires the surface's `onAbort` and cancels the upstream provider call,
      // so we stop paying for tokens the client will never receive. Without this, the
      // pump below would drain the upstream to completion against a dead socket.
      res.on('close', () => {
        if (!res.writableEnded) void reader.cancel();
      });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch {
        // Expected when the client disconnected and we cancelled the reader.
      }
    }
    res.end();
  };
}

export default toNodeHandler(createServer());
