/**
 * Tests for Phase 1A: hook invocation in GeminiSession.handleToolCalls()
 *
 * Verifies that onPreToolUse and onPostToolUse hooks are called at the right
 * points, that a 'deny' decision prevents handler execution, that modifiedArgs
 * are forwarded to the handler, and that modifiedResult replaces the original
 * tool result in the functionResponse sent back to Gemini.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GeminiSession } from '../packages/squad-sdk/dist/adapter/gemini-client.js';
import type { SquadTool, SquadSessionConfig } from '@bradygaster/squad-sdk/adapter';

// ---------------------------------------------------------------------------
// SSE stream helpers
// ---------------------------------------------------------------------------

function sseChunk(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function makeStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Returns a fetch mock that emits one functionCall then a text terminator. */
function makeFetchWithToolCall(toolName: string, args: Record<string, unknown>) {
  let callCount = 0;
  return vi.fn().mockImplementation(() => {
    callCount++;
    const isFirstCall = callCount === 1;
    const body = isFirstCall
      ? makeStream(
          sseChunk({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: toolName, args } }] } }] }),
          sseChunk({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
        )
      : makeStream(
          sseChunk({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] }),
          sseChunk({ usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 3 } }),
        );
    return Promise.resolve({ ok: true, body, status: 200 });
  });
}

// ---------------------------------------------------------------------------
// Shared tool factory
// ---------------------------------------------------------------------------

function makeTool(name: string, handler: (...args: any[]) => any): SquadTool<any> {
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

describe('GeminiSession — hooks', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls onPreToolUse with correct toolName and toolArgs', async () => {
    const onPreToolUse = vi.fn().mockResolvedValue(undefined);
    const handler = vi.fn().mockResolvedValue({ textResultForLlm: 'ok', resultType: 'success' });

    fetchSpy = makeFetchWithToolCall('test_tool', { input: 'hello' });
    vi.stubGlobal('fetch', fetchSpy);

    const session = new GeminiSession('fake-key', {
      tools: [makeTool('test_tool', handler)],
      hooks: { onPreToolUse },
    } as SquadSessionConfig);

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

    fetchSpy = makeFetchWithToolCall('test_tool', { input: 'hello' });
    vi.stubGlobal('fetch', fetchSpy);

    const session = new GeminiSession('fake-key', {
      tools: [makeTool('test_tool', handler)],
      hooks: { onPreToolUse },
    } as SquadSessionConfig);

    await session.sendMessage({ prompt: 'run the tool' });

    expect(handler).not.toHaveBeenCalled();

    // handleToolCalls appends functionResponses as a user turn, then calls
    // sendMessage('') which appends another empty user turn before fetching.
    // So the functionResponse is at contents.at(-2), not at(-1).
    const secondCallBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
    const responsePart = secondCallBody.contents.at(-2).parts[0];
    expect(responsePart.functionResponse.response.content.resultType).toBe('rejected');
    expect(responsePart.functionResponse.response.content.textResultForLlm).toContain('not allowed in this context');
  });

  it('passes modifiedArgs to the tool handler when onPreToolUse provides them', async () => {
    const onPreToolUse = vi.fn().mockResolvedValue({
      modifiedArgs: { input: 'modified-value' },
    });
    const handler = vi.fn().mockResolvedValue({ textResultForLlm: 'ok', resultType: 'success' });

    fetchSpy = makeFetchWithToolCall('test_tool', { input: 'original-value' });
    vi.stubGlobal('fetch', fetchSpy);

    const session = new GeminiSession('fake-key', {
      tools: [makeTool('test_tool', handler)],
      hooks: { onPreToolUse },
    } as SquadSessionConfig);

    await session.sendMessage({ prompt: 'run the tool' });

    expect(handler).toHaveBeenCalledOnce();
    const [effectiveArgs] = handler.mock.calls[0];
    expect(effectiveArgs).toEqual({ input: 'modified-value' });
  });

  it('calls onPostToolUse with correct toolResult', async () => {
    const onPostToolUse = vi.fn().mockResolvedValue(undefined);
    const handler = vi.fn().mockResolvedValue({ textResultForLlm: 'tool output', resultType: 'success' });

    fetchSpy = makeFetchWithToolCall('test_tool', { input: 'x' });
    vi.stubGlobal('fetch', fetchSpy);

    const session = new GeminiSession('fake-key', {
      tools: [makeTool('test_tool', handler)],
      hooks: { onPostToolUse },
    } as SquadSessionConfig);

    await session.sendMessage({ prompt: 'run the tool' });

    expect(onPostToolUse).toHaveBeenCalledOnce();
    const [input] = onPostToolUse.mock.calls[0];
    expect(input.toolName).toBe('test_tool');
    expect(input.toolResult).toMatchObject({ textResultForLlm: 'tool output', resultType: 'success' });
  });

  it('uses modifiedResult from onPostToolUse in the functionResponse', async () => {
    const onPostToolUse = vi.fn().mockResolvedValue({
      modifiedResult: { textResultForLlm: 'overridden output', resultType: 'success' },
    });
    const handler = vi.fn().mockResolvedValue({ textResultForLlm: 'original output', resultType: 'success' });

    fetchSpy = makeFetchWithToolCall('test_tool', { input: 'x' });
    vi.stubGlobal('fetch', fetchSpy);

    const session = new GeminiSession('fake-key', {
      tools: [makeTool('test_tool', handler)],
      hooks: { onPostToolUse },
    } as SquadSessionConfig);

    await session.sendMessage({ prompt: 'run the tool' });

    const secondCallBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
    const responsePart = secondCallBody.contents.at(-2).parts[0];
    expect(responsePart.functionResponse.response.content.textResultForLlm).toBe('overridden output');
  });

  it('does not call onPreToolUse or onPostToolUse when hooks is undefined', async () => {
    const handler = vi.fn().mockResolvedValue({ textResultForLlm: 'ok', resultType: 'success' });

    fetchSpy = makeFetchWithToolCall('test_tool', { input: 'x' });
    vi.stubGlobal('fetch', fetchSpy);

    // No hooks configured
    const session = new GeminiSession('fake-key', {
      tools: [makeTool('test_tool', handler)],
    } as SquadSessionConfig);

    // Should not throw; handler should still be called normally
    await session.sendMessage({ prompt: 'run the tool' });
    expect(handler).toHaveBeenCalledOnce();
  });
});
