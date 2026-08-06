/**
 * Tests for Phase 1B: tool-call recursion depth guard in GeminiSession.
 *
 * Verifies that the session throws after exceeding maxToolCallRounds,
 * succeeds within the limit, respects a custom limit, and resets the
 * counter between distinct user turns.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GeminiSession } from '../packages/squad-sdk/dist/adapter/gemini-client.js';
import type { SquadTool, SquadSessionConfig } from '@deduvafork/squad-sdk/adapter';

// ---------------------------------------------------------------------------
// SSE stream helpers (duplicated from hooks test for isolation)
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

/** Every response is a functionCall — creates an infinite loop without the guard. */
function makeLoopingFetch(toolName: string) {
  return vi.fn().mockImplementation(() => {
    const body = makeStream(
      sseChunk({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: toolName, args: {} } }] } }] }),
      sseChunk({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }),
    );
    return Promise.resolve({ ok: true, body, status: 200 });
  });
}

/** Returns a fetch mock that always responds with plain text (no tool calls). */
function makeTextFetch(text = 'Done') {
  return vi.fn().mockImplementation(() => {
    const body = makeStream(
      sseChunk({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] }),
      sseChunk({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }),
    );
    return Promise.resolve({ ok: true, body, status: 200 });
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GeminiSession — tool call depth guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws only at the runaway-loop guard, which is far above real work', async () => {
    vi.stubGlobal('fetch', makeLoopingFetch('loop_tool'));

    const session = new GeminiSession('fake-key', {
      tools: [makeLoopTool('loop_tool')],
    } as SquadSessionConfig);

    // The default used to be 10, which was a loop guard doing duty as a work
    // limit — and it was Gemini-only, so a cross-vendor comparison stopped one
    // side mid-task and let the other run on. The work limit is now
    // `maxToolRounds`, enforced for every backend in `adapter/client.ts`; this
    // number only catches a tool that genuinely loops.
    await expect(session.sendMessage({ prompt: 'go' })).rejects.toThrow(
      /maxToolCallRounds \(200\)/,
    );
  });

  it('keeps the guard above the work budget rather than equal to it', async () => {
    vi.stubGlobal('fetch', makeLoopingFetch('loop_tool'));

    // Deriving the guard from the budget made both fire on the same round and
    // race. Whichever won decided whether a spent budget was reported as a
    // milestone or as "a tool is returning function calls in a loop" — and it
    // surfaced only when a model happened to loop far enough, which is to say
    // intermittently.
    const session = new GeminiSession('fake-key', {
      tools: [makeLoopTool('loop_tool')],
      maxToolRounds: 3,
    } as SquadSessionConfig);

    await expect(session.sendMessage({ prompt: 'go' })).rejects.toThrow(
      /maxToolCallRounds \((?!3\))/,
    );
  });

  it('succeeds when tool calls stay within maxToolCallRounds', async () => {
    // First call returns a functionCall; second call returns plain text — 1 round, within limit.
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      const body = callCount === 1
        ? makeStream(
            sseChunk({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'once_tool', args: {} } }] } }] }),
            sseChunk({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }),
          )
        : makeStream(
            sseChunk({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] }),
            sseChunk({ usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 } }),
          );
      return Promise.resolve({ ok: true, body, status: 200 });
    }));

    const session = new GeminiSession('fake-key', {
      tools: [makeLoopTool('once_tool')],
      maxToolCallRounds: 5,
    } as SquadSessionConfig);

    await expect(session.sendMessage({ prompt: 'go' })).resolves.toBeUndefined();
  });

  it('respects a custom maxToolCallRounds of 2', async () => {
    vi.stubGlobal('fetch', makeLoopingFetch('loop_tool'));

    const session = new GeminiSession('fake-key', {
      tools: [makeLoopTool('loop_tool')],
      maxToolCallRounds: 2,
    } as SquadSessionConfig);

    await expect(session.sendMessage({ prompt: 'go' })).rejects.toThrow(
      /maxToolCallRounds \(2\)/,
    );
  });

  it('resets the round counter between distinct user turns', async () => {
    // Each turn: 1 functionCall then text → uses 1 round, within default limit of 10.
    // Running 3 separate turns should not accumulate rounds.
    let fetchCallCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      fetchCallCount++;
      const isToolCall = fetchCallCount % 2 === 1; // odd calls → functionCall, even → text
      const body = isToolCall
        ? makeStream(
            sseChunk({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'once_tool', args: {} } }] } }] }),
            sseChunk({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }),
          )
        : makeStream(
            sseChunk({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] }),
            sseChunk({ usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 } }),
          );
      return Promise.resolve({ ok: true, body, status: 200 });
    }));

    const session = new GeminiSession('fake-key', {
      tools: [makeLoopTool('once_tool')],
      maxToolCallRounds: 3, // deliberately tight
    } as SquadSessionConfig);

    // Three separate turns, each using 1 round — should all succeed
    await expect(session.sendMessage({ prompt: 'turn 1' })).resolves.toBeUndefined();
    await expect(session.sendMessage({ prompt: 'turn 2' })).resolves.toBeUndefined();
    await expect(session.sendMessage({ prompt: 'turn 3' })).resolves.toBeUndefined();
  });

  it('resets the round counter after a depth-limit error so the next turn works', async () => {
    // First turn: loops until depth limit throws.
    // Second turn: single text response (no tools) — should succeed without hitting the limit.
    let turnCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      turnCount++;
      // First user turn triggers many tool calls → eventually depth guard throws.
      // Second user turn (a new sendMessage call with non-empty prompt) gets a plain text response.
      const isSecondUserTurn = turnCount > 3; // after several looping calls, switch to text
      const body = isSecondUserTurn
        ? makeStream(
            sseChunk({ candidates: [{ content: { role: 'model', parts: [{ text: 'Recovered' }] }, finishReason: 'STOP' }] }),
            sseChunk({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }),
          )
        : makeStream(
            sseChunk({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'loop_tool', args: {} } }] } }] }),
            sseChunk({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }),
          );
      return Promise.resolve({ ok: true, body, status: 200 });
    }));

    const session = new GeminiSession('fake-key', {
      tools: [makeLoopTool('loop_tool')],
      maxToolCallRounds: 2,
    } as SquadSessionConfig);

    // First turn should throw from the depth guard
    await expect(session.sendMessage({ prompt: 'first turn' })).rejects.toThrow(/maxToolCallRounds/);

    // Second turn should succeed because the counter resets at the start of a new user prompt
    await expect(session.sendMessage({ prompt: 'second turn after recovery' })).resolves.toBeUndefined();
  });
});
