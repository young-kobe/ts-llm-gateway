import { handle } from '@hono/node-server/vercel';
import { createServer } from '../src/server.js';

// Vercel serverless entrypoint (Node.js runtime). vercel.json rewrites every path
// here, so this one function serves the whole gateway (GET /health, POST /v1/chat).
//
// Use the *node-server* Vercel adapter (not `hono/vercel`, which is the Edge/Web
// adapter): its `handle` returns a Node `(req, res)` handler, which is the default
// export shape Vercel's Node launcher expects.
export default handle(createServer());
