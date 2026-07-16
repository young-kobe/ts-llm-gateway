import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { buildRuntime, type ServerOverrides } from './runtime.js';
import { registerNativeChat } from './surfaces/native.js';
import { registerOpenAIChat } from './surfaces/openai.js';

export type { ServerOverrides };

/**
 * Assemble the Hono app. This is the composition overview: build the concrete
 * runtime from config (in-memory or Redis), then mount the system routes and each
 * chat "surface" (an inbound API dialect). Every surface translates to the same
 * canonical ChatRequest and shares one admission + accounting pipeline and the
 * same gateway core; they differ only in wire format. Dependencies are injectable
 * so tests run against a mock registry with no live keys.
 */
export function createServer(overrides?: ServerOverrides): Hono {
  const config = loadConfig();
  const ctx = buildRuntime(config, overrides);

  const app = new Hono();

  // System routes.
  app.get('/health', (c) => c.json({ ok: true }));
  // Live counters for the dashboard. Backend is in-memory or Redis (see config).
  app.get('/stats', async (c) => c.json(await ctx.metrics.snapshot()));

  // Chat surfaces: inbound dialects over one shared core.
  registerNativeChat(app, ctx);
  registerOpenAIChat(app, ctx);

  return app;
}
