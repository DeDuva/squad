/**
 * The bridge from backend session events onto the EventBus.
 *
 * Both halves of this existed as *types* long before anything produced them:
 * the ADP recorder has always mapped `session:tool_call`, and nothing in the
 * SDK ever emitted one. Tools ran, files changed, and the trajectory recorded
 * none of it — a gap found by reconciling a real assignment against ADP, not by
 * reading the mapping table, which looked complete.
 *
 * Runs against `src` rather than `dist` so a change here is covered before it
 * is built.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus, type SquadEvent } from '../packages/squad-sdk/src/runtime/event-bus.js';

type Handler = (event: Record<string, unknown>) => void;

/** A session that actually dispatches, so the bridge has something to bridge. */
const handlers = new Map<string, Handler[]>();
function fire(type: string, event: Record<string, unknown>): void {
  for (const handler of handlers.get(type) ?? []) handler(event);
}

vi.mock('../packages/squad-sdk/src/adapter/gemini-client.js', () => ({
  GeminiClient: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue([]),
      isStarted: vi.fn().mockReturnValue(true),
      getAuthStatus: vi.fn().mockResolvedValue({ isAuthenticated: true, authType: 'api-key' }),
      createSession: vi.fn().mockReturnValue({
        sessionId: 'session-1',
        sendMessage: vi.fn().mockResolvedValue(undefined),
        on: (type: string, handler: Handler) => {
          handlers.set(type, [...(handlers.get(type) ?? []), handler]);
        },
        off: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    };
  }),
}));

const { SquadClient } = await import('../packages/squad-sdk/src/adapter/client.js');

describe('SquadClient forwards backend session events onto the bus', () => {
  let bus: EventBus;
  let seen: SquadEvent[];

  beforeEach(async () => {
    handlers.clear();
    bus = new EventBus();
    seen = [];
    bus.subscribeAll((event) => {
      seen.push(event);
    });
    const client = new SquadClient({ geminiApiKey: 'test-key', eventBus: bus });
    await client.connect();
    await client.createSession({ model: 'gemini-2.5-flash', agentName: 'Backend' });
  });

  it('emits one tool_call event per execution, at the result, carrying the outcome', async () => {
    fire('tool_call', { toolName: 'write_file', toolCallId: 'c1', arguments: { path: 'greeting.js' } });
    fire('tool_result', { toolName: 'write_file', toolCallId: 'c1', result: { resultType: 'success' } });
    await new Promise((r) => setTimeout(r, 0));

    const tools = seen.filter((e) => e.type === 'session:tool_call');
    // One, not two: emitting at the call as well would double every tool in
    // any count taken off this bus.
    expect(tools).toHaveLength(1);
    expect(tools[0]!.agentName).toBe('Backend');
    expect(tools[0]!.payload).toEqual({
      toolName: 'write_file',
      // Paired back to the arguments the call carried — the result event has
      // none, and a tool call with no arguments is not much of a record.
      toolArgs: { path: 'greeting.js' },
      resultType: 'success',
      // Measured across the pair; asserted loosely because it is a clock.
      durationMs: expect.any(Number),
    });
  });

  // A blocked call and a broken one are different facts about an agent, and
  // ADP keeps them apart (`rejected` vs `failure`). Collapsing them here would
  // make a permission boundary look like a bug in the tool.
  it('keeps a denied tool distinct from a failed one', async () => {
    fire('tool_call', { toolName: 'run_node_test', toolCallId: 'c2', arguments: {} });
    fire('tool_result', { toolName: 'run_node_test', toolCallId: 'c2', result: { resultType: 'rejected' } });
    fire('tool_call', { toolName: 'run_node_test', toolCallId: 'c3', arguments: {} });
    fire('tool_result', { toolName: 'run_node_test', toolCallId: 'c3', result: { error: 'boom' } });
    await new Promise((r) => setTimeout(r, 0));

    const outcomes = seen
      .filter((e) => e.type === 'session:tool_call')
      .map((e) => (e.payload as { resultType: string }).resultType);
    expect(outcomes).toEqual(['rejected', 'failure']);
  });

  it('attributes model usage to the agent, not only to a session id', async () => {
    fire('usage', { inputTokens: 1200, outputTokens: 300, model: 'gemini-2.5-flash', costUsd: 0.0093 });
    await new Promise((r) => setTimeout(r, 0));

    const usage = seen.filter((e) => e.type === 'session:model_usage');
    expect(usage).toHaveLength(1);
    // Without this, CostTracker files every turn under "unknown" and the
    // per-agent cost table — the reason the tracker exists — says nothing.
    expect(usage[0]!.agentName).toBe('Backend');
    expect(usage[0]!.payload).toMatchObject({
      inputTokens: 1200,
      outputTokens: 300,
      model: 'gemini-2.5-flash',
      estimatedCost: 0.0093,
    });
  });
});

describe('SquadClient forwards the numbers a comparison needs', () => {
  let bus: EventBus;
  let seen: SquadEvent[];

  beforeEach(async () => {
    handlers.clear();
    bus = new EventBus();
    seen = [];
    bus.subscribeAll((event) => {
      seen.push(event);
    });
    const client = new SquadClient({ geminiApiKey: 'test-key', eventBus: bus });
    await client.connect();
    await client.createSession({ model: 'claude-sonnet-5', agentName: 'Backend' });
  });

  // Latency was previously unmeasurable: duration_ms was null on every event of
  // every run. The bridge is the one place that sees both ends of a tool call,
  // whichever backend raised it.
  it('measures how long a tool call took', async () => {
    fire('tool_call', { toolName: 'run_tests', toolCallId: 'c1', arguments: {} });
    await new Promise((r) => setTimeout(r, 12));
    fire('tool_result', { toolName: 'run_tests', toolCallId: 'c1', result: { resultType: 'success' } });
    await new Promise((r) => setTimeout(r, 0));

    const tool = seen.find((e) => e.type === 'session:tool_call')!;
    expect((tool.payload as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(10);
  });

  it('forwards the cache split, the per-model breakdown, and the timings', async () => {
    fire('usage', {
      inputTokens: 9407,
      outputTokens: 84,
      model: 'claude-sonnet-5',
      costUsd: 0.031,
      cacheReadInputTokens: 4658,
      cacheCreationInputTokens: 4745,
      models: [
        { model: 'claude-sonnet-5', uncachedInputTokens: 4, cacheReadInputTokens: 4658, cacheCreationInputTokens: 4745, outputTokens: 84, costUsd: 0.031 },
        { model: 'claude-haiku-4-5', uncachedInputTokens: 526, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 12, costUsd: 0.0006 },
      ],
      durationMs: 3458,
      ttftMs: 620,
      numTurns: 2,
    });
    await new Promise((r) => setTimeout(r, 0));

    const usage = seen.find((e) => e.type === 'session:model_usage')!;
    // Dropping any of these is what made tokens, cost, attribution, and
    // latency incomparable across vendors.
    expect(usage.payload).toMatchObject({
      inputTokens: 9407,
      cacheReadInputTokens: 4658,
      cacheCreationInputTokens: 4745,
      durationMs: 3458,
      ttftMs: 620,
      numTurns: 2,
    });
    expect((usage.payload as { models: unknown[] }).models).toHaveLength(2);
  });
});
