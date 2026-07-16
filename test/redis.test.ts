import { describe, it, expect } from 'vitest';
import { createRedis } from '../src/store/redis.js';

describe('createRedis env resolution', () => {
  it('returns undefined when no credentials are configured', () => {
    expect(createRedis({})).toBeUndefined();
  });

  it('builds a client from the Vercel KV env var names', () => {
    const redis = createRedis({ KV_REST_API_URL: 'https://example.upstash.io', KV_REST_API_TOKEN: 't' });
    expect(redis).toBeDefined();
  });

  it('requires both a url and a token', () => {
    expect(createRedis({ KV_REST_API_URL: 'https://example.upstash.io' })).toBeUndefined();
    expect(createRedis({ KV_REST_API_TOKEN: 't' })).toBeUndefined();
  });
});
