/**
 * Tests for AiSdkSession's streaming/usage event emission and for
 * AiSdkClient's per-model provider dispatch — not covered by the old
 * gemini-session-*.test.ts suite (which focused on hooks/depth only).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { AiSdkSession, resolveProvider } from '../packages/squad-sdk/dist/adapter/ai-sdk-session.js';
import { AiSdkClient } from '../packages/squad-sdk/dist/adapter/ai-sdk-client.js';
import type { SquadSessionConfig, SquadSessionEvent } from '@deduvafork/squad-sdk/adapter';

function v4Usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function makeTextModel(deltas: string[], usage: { input: number; output: number }) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          ...deltas.map(delta => ({ type: 'text-delta' as const, id: 't1', delta })),
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: 'stop', usage: v4Usage(usage.input, usage.output) },
        ],
      }),
    }),
  });
}

describe('AiSdkSession — streaming', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits message_delta once per text chunk', async () => {
    const deltas: string[] = [];
    const session = new AiSdkSession(
      'google',
      'fake-key',
      {} as SquadSessionConfig,
      makeTextModel(['Hello', ', ', 'world!'], { input: 10, output: 5 }),
    );
    session.on('message_delta', (event: SquadSessionEvent) => deltas.push(event['text'] as string));

    await session.sendMessage({ prompt: 'hi' });

    expect(deltas).toEqual(['Hello', ', ', 'world!']);
  });

  it('emits a usage event with correct inputTokens/outputTokens/model', async () => {
    let usageEvent: SquadSessionEvent | undefined;
    const session = new AiSdkSession(
      'google',
      'fake-key',
      { model: 'gemini-flash-latest' } as SquadSessionConfig,
      makeTextModel(['Done'], { input: 42, output: 7 }),
    );
    session.on('usage', event => { usageEvent = event; });

    await session.sendMessage({ prompt: 'hi' });

    expect(usageEvent).toBeDefined();
    expect(usageEvent!['inputTokens']).toBe(42);
    expect(usageEvent!['outputTokens']).toBe(7);
    expect(usageEvent!['model']).toBe('gemini-flash-latest');
  });

  it('emits turn_end after usage', async () => {
    const order: string[] = [];
    const session = new AiSdkSession(
      'google',
      'fake-key',
      {} as SquadSessionConfig,
      makeTextModel(['Done'], { input: 1, output: 1 }),
    );
    session.on('usage', () => order.push('usage'));
    session.on('turn_end', () => order.push('turn_end'));

    await session.sendMessage({ prompt: 'hi' });

    expect(order).toEqual(['usage', 'turn_end']);
  });
});

describe('resolveProvider', () => {
  it('dispatches claude-* models to anthropic', () => {
    expect(resolveProvider('claude-sonnet-5')).toBe('anthropic');
    expect(resolveProvider('claude-opus-4-8')).toBe('anthropic');
    expect(resolveProvider('claude-haiku-4-5')).toBe('anthropic');
  });

  it('dispatches everything else to google', () => {
    expect(resolveProvider('gemini-flash-latest')).toBe('google');
    expect(resolveProvider('gemini-pro-latest')).toBe('google');
  });
});

describe('AiSdkClient — provider key resolution', () => {
  it('throws a clear error creating a claude-* session with only a Gemini key configured', () => {
    const client = new AiSdkClient({ gemini: 'gemini-key-only' });
    expect(() => client.createSession({ model: 'claude-sonnet-5' } as SquadSessionConfig)).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('throws a clear error creating a gemini session with only an Anthropic key configured', () => {
    const client = new AiSdkClient({ anthropic: 'anthropic-key-only' });
    expect(() => client.createSession({ model: 'gemini-flash-latest' } as SquadSessionConfig)).toThrow(
      /GEMINI_API_KEY/,
    );
  });

  it('creates a session when the matching key is configured', () => {
    const client = new AiSdkClient({ gemini: 'gemini-key', anthropic: 'anthropic-key' });
    expect(() => client.createSession({ model: 'gemini-flash-latest' } as SquadSessionConfig)).not.toThrow();
    expect(() => client.createSession({ model: 'claude-sonnet-5' } as SquadSessionConfig)).not.toThrow();
  });
});
