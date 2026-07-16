import { handle } from 'hono/vercel';
import { createServer } from '../src/server';

// Vercel serverless entrypoint. All routes are rewritten here by vercel.json, so
// this one function serves the whole gateway (GET /health, POST /v1/chat).
const app = createServer();

export default handle(app);
