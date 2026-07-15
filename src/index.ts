import { serve } from '@hono/node-server';
import { createServer } from './server';
import { loadConfig } from './config';

const { port } = loadConfig();
const app = createServer();

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`ts-llm-gateway listening on http://localhost:${info.port}`);
});
