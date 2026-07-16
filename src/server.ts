import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { buildRuntime, type ServerOverrides } from './runtime.js';
import { nativeChatHandler } from './surfaces/native.js';
import { openAIChatHandler } from './surfaces/openai.js';

export type { ServerOverrides };

/**
 * Assemble the Hono app. This is the composition overview: build the concrete
 * runtime from config (in-memory or Redis), then declare the full route table
 * here. The chat "surfaces" (inbound API dialects) are handler factories, so every
 * endpoint and path is visible in this one place. Every surface translates to the
 * same canonical ChatRequest and shares one admission + accounting pipeline and
 * the same gateway core; they differ only in wire format. Dependencies are
 * injectable so tests run against a mock registry with no live keys.
 */
export function createServer(overrides?: ServerOverrides): Hono {
  const config = loadConfig();
  const ctx = buildRuntime(config, overrides);

  const app = new Hono();

  // Route table.
  app.get('/health', (c) => c.json({ ok: true }));
  // Live counters for the dashboard. Backend is in-memory or Redis (see config).
  app.get('/stats', async (c) => c.json(await ctx.metrics.snapshot()));
  app.post('/v1/chat', nativeChatHandler(ctx)); // native surface
  app.post('/v1/chat/completions', openAIChatHandler(ctx)); // OpenAI-compatible surface (spec path)

  return app;
}
