import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createServer } from './server.js';
import { loadConfig } from './config.js';

const { port } = loadConfig();
const app = createServer();

// Local-dev convenience: serve the static landing page + dashboard from public/.
// Registered after the API routes, so /health, /stats, and /v1/chat take precedence
// and only unmatched paths (like /) fall through to the static files. On Vercel this
// is handled by the platform's static hosting, not this entrypoint.
app.use('/*', serveStatic({ root: './public', index: 'index.html' }));

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`ts-llm-gateway listening on http://localhost:${info.port}`);
});
