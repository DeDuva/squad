/**
 * Tests for tool-call round-depth enforcement in AiSdkSession.
 *
 * Parallels gemini-session-depth.test.ts's behavioral spec: throws after
 * exceeding maxToolCallRounds, succeeds within the limit, respects a custom
 * limit, and resets between distinct sendMessage() calls (each call drives
 * its own streamText() invocation with its own step count, so — unlike
 * GeminiSession's manual counter — no explicit reset logic is needed).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { AiSdkSession } from '../packages/squad-sdk/dist/adapter/ai-sdk-session.js';
import type { SquadTool, SquadSessionConfig } from '@deduvafork/squad-sdk/adapter';

function v4Usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function toolCallStream(toolName: string) {
  return simulateReadableStream({
    chunks: [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: `call-${Math.random()}`, toolName, input: '{}' },
      { type: 'finish', finishReason: 'tool-calls', usage: v4Usage(5, 2) },
    ],
  });
}

function textStream(text = 'Done') {
  return simulateReadableStream({
    chunks: [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: text },
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: 'stop', usage: v4Usage(8, 3) },
    ],
  });
}

/** Every step is a tool call — infinite loop without the depth guard. */
function makeLoopingModel(toolName: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: toolCallStream(toolName) }),
  });
}

function makeLoopTool(name: string): SquadTool<any> {
  return {
    name,
    description: 'loops forever',
    parameters: { type: 'object', properties: {} },
    handler: vi.fn().mockResolvedValue({ textResultForLlm: 'looping', resultType: 'success' }),
  };
}

describe('AiSdkSession — tool call depth guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws after exceeding the default maxToolCallRounds of 10', async () => {
    const session = new AiSdkSession(
      'google',
      'fake-key',
      { tools: [makeLoopTool('loop_tool')] } as SquadSessionConfig,
      makeLoopingModel('loop_tool'),
    );

    await expect(session.sendMessage({ prompt: 'go' })).rejects.toThrow(
      /maxToolCallRounds \(10\)/,
    );
  });

  it('succeeds when tool calls stay within maxToolCallRounds', async () => {
    let callCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callCount++;
        return { stream: callCount === 1 ? toolCallStream('once_tool') : textStream() };
      },
    });

    const session = new AiSdkSession(
      'google',
      'fake-key',
      { tools: [makeLoopTool('once_tool')], maxToolCallRounds: 5 } as SquadSessionConfig,
      model,
    );

    await expect(session.sendMessage({ prompt: 'go' })).resolves.toBeUndefined();
  });

  it('respects a custom maxToolCallRounds of 2', async () => {
    const session = new AiSdkSession(
      'google',
      'fake-key',
      { tools: [makeLoopTool('loop_tool')], maxToolCallRounds: 2 } as SquadSessionConfig,
      makeLoopingModel('loop_tool'),
    );

    await expect(session.sendMessage({ prompt: 'go' })).rejects.toThrow(
      /maxToolCallRounds \(2\)/,
    );
  });

  it('resets between distinct sendMessage() calls', async () => {
    // Each call: 1 tool-call step then a text step — within default limit of 10.
    let callCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callCount++;
        const isToolCall = callCount % 2 === 1;
        return { stream: isToolCall ? toolCallStream('once_tool') : textStream() };
      },
    });

    const session = new AiSdkSession(
      'google',
      'fake-key',
      { tools: [makeLoopTool('once_tool')], maxToolCallRounds: 3 } as SquadSessionConfig,
      model,
    );

    await expect(session.sendMessage({ prompt: 'turn 1' })).resolves.toBeUndefined();
    await expect(session.sendMessage({ prompt: 'turn 2' })).resolves.toBeUndefined();
    await expect(session.sendMessage({ prompt: 'turn 3' })).resolves.toBeUndefined();
  });

  it('recovers after a depth-limit error so the next turn works', async () => {
    // First user turn (maxToolCallRounds=2): first 2 doStream calls loop with
    // tool calls, hitting the depth guard. Second user turn: doStream calls
    // beyond that return plain text — same session, same underlying model,
    // proving the guard doesn't persist across sendMessage() calls.
    let doStreamCallCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        doStreamCallCount++;
        return { stream: doStreamCallCount <= 2 ? toolCallStream('loop_tool') : textStream('Recovered') };
      },
    });

    const session = new AiSdkSession(
      'google',
      'fake-key',
      { tools: [makeLoopTool('loop_tool')], maxToolCallRounds: 2 } as SquadSessionConfig,
      model,
    );

    await expect(session.sendMessage({ prompt: 'first turn' })).rejects.toThrow(/maxToolCallRounds/);
    await expect(session.sendMessage({ prompt: 'second turn after recovery' })).resolves.toBeUndefined();
  });
});
