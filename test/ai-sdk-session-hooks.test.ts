/**
 * Tests for hook invocation in AiSdkSession's tool execute() wrapping.
 *
 * Parallels gemini-session-hooks.test.ts's behavioral spec: onPreToolUse and
 * onPostToolUse are called at the right points, a 'deny' decision prevents
 * handler execution, modifiedArgs are forwarded to the handler, and
 * modifiedResult replaces the original tool result.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { AiSdkSession } from '../packages/squad-sdk/dist/adapter/ai-sdk-session.js';
import type { SquadTool, SquadSessionConfig } from '@deduvafork/squad-sdk/adapter';

// ---------------------------------------------------------------------------
// Mock model helpers
// ---------------------------------------------------------------------------

function v4Usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

/** Model that emits one tool-call step, then a plain text finish step. */
function makeToolCallThenTextModel(toolName: string, args: Record<string, unknown>) {
  let callIndex = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      callIndex++;
      if (callIndex === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(args) },
              { type: 'finish', finishReason: 'tool-calls', usage: v4Usage(10, 5) },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Done' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: 'stop', usage: v4Usage(15, 3) },
          ],
        }),
      };
    },
  });
}

function makeTool(name: string, handler: (...args: unknown[]) => unknown): SquadTool<any> {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: { type: 'object', properties: { input: { type: 'string' } } },
    handler,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AiSdkSession — hooks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls onPreToolUse with correct toolName and toolArgs', async () => {
    const onPreToolUse = vi.fn().mockResolvedValue(undefined);
    const handler = vi.fn().mockResolvedValue({ textResultForLlm: 'ok', resultType: 'success' });

    const session = new AiSdkSession(
      'google',
      'fake-key',
      {
        tools: [makeTool('test_tool', handler)],
        hooks: { onPreToolUse },
      } as SquadSessionConfig,
      makeToolCallThenTextModel('test_tool', { input: 'hello' }),
    );

    await session.sendMessage({ prompt: 'run the tool' });

    expect(onPreToolUse).toHaveBeenCalledOnce();
    const [input] = onPreToolUse.mock.calls[0];
    expect(input.toolName).toBe('test_tool');
    expect(input.toolArgs).toEqual({ input: 'hello' });
    expect(typeof input.timestamp).toBe('number');
    expect(typeof input.cwd).toBe('string');
  });

  it('blocks tool execution when onPreToolUse returns permissionDecision: deny', async () => {
    const onPreToolUse = vi.fn().mockResolvedValue({
      permissionDecision: 'deny',
      permissionDecisionReason: 'not allowed in this context',
    });
    const handler = vi.fn().mockResolvedValue({ textResultForLlm: 'should not run', resultType: 'success' });
    const toolResultEvents: unknown[] = [];

    const session = new AiSdkSession(
      'google',
      'fake-key',
      {
        tools: [makeTool('test_tool', handler)],
        hooks: { onPreToolUse },
      } as SquadSessionConfig,
      makeToolCallThenTextModel('test_tool', { input: 'hello' }),
    );
    session.on('tool_result', event => toolResultEvents.push(event));

    await session.sendMessage({ prompt: 'run the tool' });

    expect(handler).not.toHaveBeenCalled();
    const result = (toolResultEvents[0] as { result: { resultType: string; textResultForLlm: string } }).result;
    expect(result.resultType).toBe('rejected');
    expect(result.textResultForLlm).toContain('not allowed in this context');
  });

  it('passes modifiedArgs to the tool handler when onPreToolUse provides them', async () => {
    const onPreToolUse = vi.fn().mockResolvedValue({
      modifiedArgs: { input: 'modified-value' },
    });
    const handler = vi.fn().mockResolvedValue({ textResultForLlm: 'ok', resultType: 'success' });

    const session = new AiSdkSession(
      'google',
      'fake-key',
      {
        tools: [makeTool('test_tool', handler)],
        hooks: { onPreToolUse },
      } as SquadSessionConfig,
      makeToolCallThenTextModel('test_tool', { input: 'original-value' }),
    );

    await session.sendMessage({ prompt: 'run the tool' });

    expect(handler).toHaveBeenCalledOnce();
    const [effectiveArgs] = handler.mock.calls[0];
    expect(effectiveArgs).toEqual({ input: 'modified-value' });
  });

  it('calls onPostToolUse with correct toolResult', async () => {
    const onPostToolUse = vi.fn().mockResolvedValue(undefined);
    const handler = vi.fn().mockResolvedValue({ textResultForLlm: 'tool output', resultType: 'success' });

    const session = new AiSdkSession(
      'google',
      'fake-key',
      {
        tools: [makeTool('test_tool', handler)],
        hooks: { onPostToolUse },
      } as SquadSessionConfig,
      makeToolCallThenTextModel('test_tool', { input: 'x' }),
    );

    await session.sendMessage({ prompt: 'run the tool' });

    expect(onPostToolUse).toHaveBeenCalledOnce();
    const [input] = onPostToolUse.mock.calls[0];
    expect(input.toolName).toBe('test_tool');
    expect(input.toolResult).toMatchObject({ textResultForLlm: 'tool output', resultType: 'success' });
  });

  it('uses modifiedResult from onPostToolUse in the tool result event', async () => {
    const onPostToolUse = vi.fn().mockResolvedValue({
      modifiedResult: { textResultForLlm: 'overridden output', resultType: 'success' },
    });
    const handler = vi.fn().mockResolvedValue({ textResultForLlm: 'original output', resultType: 'success' });
    const toolResultEvents: unknown[] = [];

    const session = new AiSdkSession(
      'google',
      'fake-key',
      {
        tools: [makeTool('test_tool', handler)],
        hooks: { onPostToolUse },
      } as SquadSessionConfig,
      makeToolCallThenTextModel('test_tool', { input: 'x' }),
    );
    session.on('tool_result', event => toolResultEvents.push(event));

    await session.sendMessage({ prompt: 'run the tool' });

    const result = (toolResultEvents[0] as { result: { textResultForLlm: string } }).result;
    expect(result.textResultForLlm).toBe('overridden output');
  });

  it('does not call onPreToolUse or onPostToolUse when hooks is undefined', async () => {
    const handler = vi.fn().mockResolvedValue({ textResultForLlm: 'ok', resultType: 'success' });

    const session = new AiSdkSession(
      'google',
      'fake-key',
      { tools: [makeTool('test_tool', handler)] } as SquadSessionConfig,
      makeToolCallThenTextModel('test_tool', { input: 'x' }),
    );

    await session.sendMessage({ prompt: 'run the tool' });
    expect(handler).toHaveBeenCalledOnce();
  });
});
