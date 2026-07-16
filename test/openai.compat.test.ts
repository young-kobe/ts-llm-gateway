import { describe, it, expect } from 'vitest';
import {
  parseModelRoute,
  toChatRequest,
  toOpenAIResponse,
  openAIChunk,
  type CompletionMeta,
  type OpenAIChatRequest,
} from '../src/openai/compat.js';
import type { ChatResponse } from '../src/types.js';

const META: CompletionMeta = { id: 'chatcmpl-test', created: 1_700_000_000 };

describe('parseModelRoute', () => {
  it('peels off a known provider prefix', () => {
    expect(parseModelRoute('openai/gpt-4o-mini')).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(parseModelRoute('bedrock/anthropic.claude-3-5-sonnet')).toEqual({
      provider: 'bedrock',
      model: 'anthropic.claude-3-5-sonnet',
    });
  });

  it('leaves a bare model id (no slash) untouched', () => {
    expect(parseModelRoute('gpt-4o-mini')).toEqual({ model: 'gpt-4o-mini' });
  });

  it('does not mangle a slashed id whose prefix is not a known provider', () => {
    // e.g. a Bedrock inference-profile ARN, which itself contains '/'
    const arn = 'arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude';
    expect(parseModelRoute(arn)).toEqual({ model: arn });
  });
});

describe('toChatRequest', () => {
  it('routes on the model prefix and maps fields', () => {
    const body: OpenAIChatRequest = {
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      max_tokens: 100,
    };
    expect(toChatRequest(body)).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      maxTokens: 100,
    });
  });

  it('prefers max_completion_tokens over the legacy max_tokens', () => {
    const req = toChatRequest({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      max_completion_tokens: 42,
    });
    expect(req.maxTokens).toBe(42);
  });

  it('leaves provider undefined when no prefix is present (default routing)', () => {
    const req = toChatRequest({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
    expect(req.provider).toBeUndefined();
  });
});

describe('toOpenAIResponse', () => {
  it('produces a chat.completion object and echoes the requested model', () => {
    const result: ChatResponse = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      text: 'hello',
      usage: { inputTokens: 7, outputTokens: 11 },
      cached: false,
    };
    const out = toOpenAIResponse(result, 'openai/gpt-4o-mini', META) as any;

    expect(out.object).toBe('chat.completion');
    expect(out.id).toBe('chatcmpl-test');
    expect(out.model).toBe('openai/gpt-4o-mini'); // echoes what the caller requested
    expect(out.choices).toEqual([
      { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
    ]);
    expect(out.usage).toEqual({ prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 });
  });

  it('treats missing token counts as zero', () => {
    const result: ChatResponse = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      text: 'hi',
      usage: { inputTokens: undefined, outputTokens: undefined },
      cached: true,
    };
    const out = toOpenAIResponse(result, 'gpt-4o-mini', META) as any;
    expect(out.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

describe('openAIChunk', () => {
  it('builds role, content, and finish chunks', () => {
    expect(openAIChunk.role(META, 'gpt-4o-mini')).toMatchObject({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
    expect(openAIChunk.content(META, 'gpt-4o-mini', 'Hel')).toMatchObject({
      choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }],
    });
    expect(openAIChunk.finish(META, 'gpt-4o-mini')).toMatchObject({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
  });
});
