/**
 * The neutral loop, judged by the same contract as the native one.
 *
 * Driven by the SDK's own mock model, so the loop's behaviour is pinned without
 * a key and without a bill. That is not a compromise: every clause in the
 * contract is about the harness's bookkeeping — does a turn resolve after its
 * tools ran, is a spent budget a milestone or a crash — and none of it depends
 * on the model being real. The wire-level questions that *do* need a real model
 * are the parity probe's, and that runs against live providers.
 *
 * Live validation of this harness against Anthropic is blocked on an
 * `ANTHROPIC_API_KEY`: the machine authenticates through the `claude` CLI's
 * OAuth chain, which the SDK provider cannot use. `harness-check --ai-sdk`
 * runs it the moment a key exists.
 */

import { describe, it, expect } from 'vitest';
import { MockLanguageModelV2 } from 'ai/test';

import { EventBus, type SquadEvent } from '../packages/squad-sdk/src/runtime/event-bus.js';
import { checkHarnessConformance, type ConformanceContext } from '../packages/squad-lab/src/conformance.ts';
import { createAiSdkHarness } from '../packages/squad-lab/src/harnesses/ai-sdk.ts';

/**
 * A model that calls every tool it is offered, once per step, until `rounds`
 * steps have passed — then answers with text.
 */
function scriptedModel(rounds: number) {
  let step = 0;
  return new MockLanguageModelV2({
    doGenerate: async ({ tools }) => {
      step += 1;
      const available = (tools ?? []) as { name: string }[];
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

      if (step <= rounds && available.length > 0) {
        return {
          finishReason: 'tool-calls' as const,
          usage,
          content: available.map((t, i) => ({
            type: 'tool-call' as const,
            toolCallId: `call-${step}-${i}`,
            toolName: t.name,
            input: JSON.stringify({}),
          })),
          warnings: [],
        };
      }
      return {
        finishReason: 'stop' as const,
        usage,
        content: [{ type: 'text' as const, text: 'done' }],
        warnings: [],
      };
    },
  });
}

function harnessWith(rounds: number): ConformanceContext {
  const bus = new EventBus();
  const seen: SquadEvent[] = [];
  bus.subscribeAll((e) => {
    seen.push(e);
  });

  const createSession = createAiSdkHarness({
    bus,
    provider: 'anthropic',
    model: 'mock',
    resolveModel: () => scriptedModel(rounds),
  });

  return {
    events: () => [...seen],
    reset: () => {
      seen.length = 0;
    },
    createSession,
  };
}

describe('the AI SDK harness', () => {
  it('keeps the whole conformance contract', async () => {
    // A model that would loop forever if nothing stopped it, so the budget
    // clause is exercised rather than accidentally satisfied.
    const report = await checkHarnessConformance('ai-sdk:mock', harnessWith(50));
    const failures = report.clauses.filter((c) => !c.ok).map((c) => `${c.clause}: ${c.detail ?? ''}`);
    expect(failures).toEqual([]);
  }, 60_000);

  it('stops at the budget it was given and says so as a milestone', async () => {
    const ctx = harnessWith(50);
    const calls: string[] = [];
    const session = await ctx.createSession({
      agentName: 'Prober',
      tools: [
        {
          name: 'probe',
          description: 'probe',
          parameters: { type: 'object', properties: {} },
          handler: async () => {
            calls.push('probe');
            return 'ok';
          },
        },
      ],
      maxToolRounds: 3,
    });
    await session.sendAndWait?.({ prompt: 'loop forever' }, 30_000);

    expect(calls.length).toBeLessThanOrEqual(4);
    const milestones = ctx
      .events()
      .filter((e) => String(e.type) === 'agent:milestone')
      .map((e) => (e.payload as { event?: string })?.event);
    expect(milestones).toContain('budget.exhausted');
    // And never as an error, which is what makes a spent budget distinguishable
    // from a crash in a summary.
    expect(ctx.events().filter((e) => String(e.type) === 'session:error')).toHaveLength(0);
  }, 60_000);

  it('reports a throwing tool as a failed call rather than losing the turn', async () => {
    const ctx = harnessWith(1);
    const session = await ctx.createSession({
      agentName: 'Prober',
      tools: [
        {
          name: 'explode',
          description: 'throws',
          parameters: { type: 'object', properties: {} },
          handler: async () => {
            throw new Error('boom');
          },
        },
      ],
      maxToolRounds: 4,
    });
    await expect(session.sendAndWait?.({ prompt: 'call explode' }, 30_000)).resolves.toBeDefined();

    const toolEvents = ctx.events().filter((e) => String(e.type) === 'session:tool_call');
    expect(toolEvents).toHaveLength(1);
    expect((toolEvents[0]!.payload as { resultType?: string }).resultType).toBe('failure');
  }, 60_000);

  it('reports token usage per step', async () => {
    const ctx = harnessWith(2);
    const session = await ctx.createSession({
      agentName: 'Prober',
      tools: [
        {
          name: 'probe',
          description: 'probe',
          parameters: { type: 'object', properties: {} },
          handler: async () => 'ok',
        },
      ],
      maxToolRounds: 10,
    });
    await session.sendAndWait?.({ prompt: 'go' }, 30_000);

    const usage = ctx.events().filter((e) => String(e.type) === 'session:model_usage');
    // One per step, not one per turn: a comparison that reads tokens off the
    // last step under-counts a multi-step run by however many steps it took.
    expect(usage.length).toBeGreaterThan(1);
    expect((usage[0]!.payload as { inputTokens?: number }).inputTokens).toBe(10);
  }, 60_000);
});
