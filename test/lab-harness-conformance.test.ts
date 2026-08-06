/**
 * The harness contract, checked against harnesses that deliberately break it.
 *
 * The suite's value is entirely in what it *catches*, so the tests here are
 * mostly harnesses built to fail one clause each. The one that matters is
 * `capped-like-gemini`: a harness that stops at its own hidden ceiling and
 * reports it as a session error. That is precisely what the Gemini backend did
 * during the three-model comparison, and nothing in the suite, the summary or
 * ADP said the comparison had been invalidated.
 */

import { describe, it, expect } from 'vitest';
import { EventBus, type SquadEvent } from '../packages/squad-sdk/src/runtime/event-bus.js';
import {
  checkHarnessConformance,
  formatConformance,
  type ConformanceContext,
  type ConformanceTool,
} from '../packages/squad-lab/src/conformance.ts';

interface FakeOptions {
  /** Stop after this many tool rounds regardless of the budget it was given. */
  hiddenCeiling?: number;
  /** Report hitting the ceiling as a session error, the way Gemini does. */
  ceilingIsAnError?: boolean;
  /** Resolve the turn before running any tools. */
  resolveOnDispatch?: boolean;
  /** Swallow tool failures and report them as successes. */
  hideToolFailures?: boolean;
  omit?: ('created' | 'destroyed' | 'usage' | 'tool_call')[];
}

/**
 * A scripted harness: it "calls" every tool it is given, once per round, until
 * something stops it. No model, no network — the contract is about the
 * bookkeeping around a model, and that is what this exercises.
 */
function fakeHarness(options: FakeOptions = {}) {
  const bus = new EventBus();
  const seen: SquadEvent[] = [];
  bus.subscribeAll((e) => seen.push(e));
  const omit = new Set(options.omit ?? []);

  const emit = (type: string, agentName: string, payload: Record<string, unknown>) => {
    void bus.emit({ type, agentName, payload, timestamp: new Date() } as never);
  };

  const ctx: ConformanceContext = {
    events: () => [...seen],
    reset: () => {
      seen.length = 0;
    },
    createSession: async (config) => {
      const agentName = config.agentName ?? 'agent';
      const tools = (config.tools ?? []) as ConformanceTool[];
      const sessionId = `fake-${Math.random().toString(36).slice(2, 8)}`;
      let aborted = false;

      if (!omit.has('created')) emit('session:created', agentName, { agentName, priority: 'normal' });

      const runTurn = async () => {
        const budget = options.hiddenCeiling ?? config.maxToolRounds ?? 10;
        let round = 0;
        try {
          while (round < budget && !aborted) {
            round += 1;
            for (const tool of tools) {
              const startedAt = Date.now();
              let resultType: 'success' | 'failure' = 'success';
              try {
                await tool.handler({});
              } catch {
                resultType = 'failure';
              }
              if (!omit.has('tool_call')) {
                emit('session:tool_call', agentName, {
                  toolName: tool.name,
                  toolArgs: {},
                  resultType: options.hideToolFailures ? 'success' : resultType,
                  durationMs: Date.now() - startedAt,
                });
              }
            }
          }

          if (round >= budget && !aborted) {
            if (options.ceilingIsAnError) {
              // Gemini's shape, exactly: a throw whose message reads like a
              // malfunction rather than a budget being spent.
              emit('session:error', agentName, {
                agentName,
                error: `Tool call depth exceeded maxToolCallRounds (${budget}). This usually means a tool is returning function calls in a loop.`,
              });
              if (!omit.has('destroyed')) emit('session:destroyed', agentName, { agentName, reason: 'error' });
              throw new Error(`Tool call depth exceeded maxToolCallRounds (${budget}).`);
            }
            emit('agent:milestone', agentName, {
              event: 'budget.exhausted',
              agentName,
              rounds: round,
              budget,
            });
          }

          if (!omit.has('usage')) {
            emit('session:model_usage', agentName, {
              model: 'fake-1',
              inputTokens: 100 * round,
              outputTokens: 10 * round,
              agentName,
            });
          }
          if (!omit.has('destroyed')) emit('session:destroyed', agentName, { agentName, reason: 'complete' });
        } catch (err) {
          if (!omit.has('usage')) {
            emit('session:model_usage', agentName, { model: 'fake-1', inputTokens: 1, outputTokens: 0, agentName });
          }
          throw err;
        }
      };

      return {
        sessionId,
        sendMessage: async () => {
          void runTurn();
        },
        sendAndWait: async () => {
          if (options.resolveOnDispatch) {
            void runTurn();
            return 'dispatched';
          }
          await runTurn();
          return 'done';
        },
        abort: async () => {
          aborted = true;
        },
      };
    },
  };

  return ctx;
}

const clause = (report: Awaited<ReturnType<typeof checkHarnessConformance>>, needle: string) =>
  report.clauses.find((c) => c.clause.includes(needle))!;

describe('a harness that behaves', () => {
  it('passes every clause', async () => {
    const report = await checkHarnessConformance('well-behaved', fakeHarness());
    expect(formatConformance(report)).toContain('0 failed');
    expect(report.failed).toBe(0);
  });
});

describe('the clause the Gemini comparison broke', () => {
  it('catches a harness with a hidden ceiling below the budget it was given', async () => {
    // The real defect: asked for a budget of 3, it stops at 2 of its own
    // accord. In the live run the numbers were 10 against a task that needed
    // more, while the other vendor ran unbounded.
    const report = await checkHarnessConformance('capped-like-gemini', fakeHarness({ hiddenCeiling: 2, ceilingIsAnError: true }));
    expect(clause(report, 'budget exhaustion as a milestone').ok).toBe(false);
    expect(clause(report, 'budget exhaustion as a milestone').detail).toMatch(/maxToolCallRounds/);
  });

  it('accepts a harness that stops at the budget and says so as a milestone', async () => {
    const report = await checkHarnessConformance('budgeted', fakeHarness({ hiddenCeiling: 3, ceilingIsAnError: false }));
    expect(clause(report, 'honours the tool-round budget').ok).toBe(true);
    expect(clause(report, 'budget exhaustion as a milestone').ok).toBe(true);
  });

  it('catches a harness that ignores the budget and runs away', async () => {
    const report = await checkHarnessConformance('unbounded', fakeHarness({ hiddenCeiling: 40 }));
    expect(clause(report, 'honours the tool-round budget').ok).toBe(false);
    expect(clause(report, 'honours the tool-round budget').detail).toMatch(/against a budget of 3/);
  });
});

describe('the rest of the contract', () => {
  it('catches a turn that resolves before its tools have run', async () => {
    // This is what would make every run look instantaneous and every
    // trajectory look truncated.
    const report = await checkHarnessConformance('dispatch-only', fakeHarness({ resolveOnDispatch: true }));
    expect(clause(report, 'resolves only after the tools have run').ok).toBe(false);
  });

  it('catches a harness that hides tool failures', async () => {
    const report = await checkHarnessConformance('optimistic', fakeHarness({ hideToolFailures: true }));
    expect(clause(report, 'failed tool call').ok).toBe(false);
  });

  // `created`/`destroyed` are not in the contract — fan-out emits them around
  // any session factory, so they are constant across harnesses. Running the
  // suite against the real backends is what established that.
  it.each([
    ['usage', 'token usage'],
    ['tool_call', 'each tool call'],
  ] as const)('catches a harness that never emits %s', async (omitted, needle) => {
    const report = await checkHarnessConformance(`no-${omitted}`, fakeHarness({ omit: [omitted] }));
    expect(clause(report, needle).ok).toBe(false);
  });

  it('explains why a clause exists when it fails', async () => {
    // A conformance failure that does not say what it protects gets silenced.
    const report = await checkHarnessConformance('no-usage', fakeHarness({ omit: ['usage'] }));
    expect(formatConformance(report)).toMatch(/why: .*cost|why: .*token/i);
  });
});
