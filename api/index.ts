import { handle } from 'hono/vercel';
import { createServer } from '../src/server.js';

// Vercel serverless entrypoint. All routes are rewritten here by vercel.json, so
// this one function serves the whole gateway (GET /health, POST /v1/chat).
//
// Vercel's Node runtime dispatches by HTTP method to named Web (fetch-style)
// exports. `handle(app)` returns a `(request) => Response` handler; Hono routes
// by path internally, so GET and POST both point at it.
const handler = handle(createServer());

export const GET = handler;
export const POST = handler;
