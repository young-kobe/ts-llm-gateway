import { Hono } from 'hono';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import { handleChat, UnknownProviderError, type GatewayDeps } from './gateway';
import { buildDefaultRegistry } from './providers';
import { loadConfig } from './config';

// Minimal message shape for the skeleton: plain-text turns. Tool/multi-part
// content is intentionally out of scope until it's actually needed.
const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

const chatRequestSchema = z.object({
  provider: z.enum(['bedrock', 'openai']).optional(),
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});

/**
 * Build the Hono app. Dependencies default to the real provider registry but can
 * be injected — the integration tests pass a mock registry so no keys are needed.
 */
export function createServer(deps?: Partial<GatewayDeps>): Hono {
  const config = loadConfig();
  const resolved: GatewayDeps = {
    providers: deps?.providers ?? buildDefaultRegistry(),
    defaultProvider: deps?.defaultProvider ?? config.defaultProvider,
  };

  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/v1/chat', async (c) => {
    const parsed = chatRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    }

    try {
      // `messages` is validated to plain-text turns above; the cast bridges the
      // narrowed literal shape to the SDK's broader ModelMessage union.
      const result = await handleChat(
        { ...parsed.data, messages: parsed.data.messages as ModelMessage[] },
        resolved,
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof UnknownProviderError) {
        return c.json({ error: 'unknown_provider', provider: err.provider }, 400);
      }
      const message = err instanceof Error ? err.message : 'upstream provider error';
      return c.json({ error: 'upstream_error', message }, 502);
    }
  });

  return app;
}
