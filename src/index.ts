import { serve } from '@hono/node-server';
import { createServer } from './server.js';
import { loadConfig } from './config.js';

const { port } = loadConfig();
const app = createServer();

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`ts-llm-gateway listening on http://localhost:${info.port}`);
});
