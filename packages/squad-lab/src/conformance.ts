/**
 * What a harness has to do to be swappable.
 *
 * squad-lab drives agents through exactly one function — `createSession` — and
 * everything downstream (the ADP recorder, the run attestation, the grader, the
 * summary, the SPA) consumes only a handful of bus events. That makes the
 * harness replaceable in principle. This is the suite that makes it replaceable
 * in practice: run it against any `SessionFactory` and it either satisfies the
 * contract or names the clause it broke.
 *
 * It exists because of a specific failure. The Gemini backend caps sequential
 * tool rounds at ten and throws when it hits the cap; the Anthropic backend has
 * no equivalent limit. A three-model comparison therefore stopped one vendor
 * mid-exploration and let the others run to 105 tool calls — and the only trace
 * was a `session:error` in a log nobody reads. No test failed. Nothing in the
 * summary said the comparison was invalid.
 *
 * So the contract below is not a style guide. Every clause is something that,
 * when it differs silently between two harnesses, turns a comparison into a
 * number that looks like one.
 */

import type { SquadEvent } from '@deduvafork/squad-sdk/runtime/event-bus';

/** The session surface squad-lab actually depends on. */
export interface ConformingSession {
  readonly sessionId: string;
  sendAndWait?(options: { prompt: string; mode?: 'immediate' }, timeoutMs?: number): Promise<unknown>;
  sendMessage(options: { prompt: string; mode?: 'immediate' }): Promise<void>;
  abort?(): Promise<void>;
}

export interface ConformanceTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface SessionFactory {
  (config: {
    model?: string;
    clientName?: string;
    agentName?: string;
    workingDirectory?: string;
    tools?: ConformanceTool[];
    systemMessage?: { mode?: 'append' | 'replace'; content: string };
    /** The symmetric budget. A harness that ignores it fails clause 5. */
    maxToolRounds?: number;
  }): Promise<ConformingSession>;
}

export interface ConformanceContext {
  createSession: SessionFactory;
  /** Every event the harness put on the bus, in order. */
  events: () => SquadEvent[];
  /** Drop recorded events between clauses. */
  reset: () => void;
}

export interface ClauseResult {
  clause: string;
  ok: boolean;
  detail?: string;
  /** Why this clause exists — printed on failure, so the fix is obvious. */
  because: string;
}

export interface ConformanceReport {
  harness: string;
  passed: number;
  failed: number;
  clauses: ClauseResult[];
}

const TOOL_ROUND_BUDGET = 3;

/** A tool that always asks to be called again, to drive the budget clause. */
function loopingTool(calls: { n: number }): ConformanceTool {
  return {
    name: 'probe',
    description: 'Records that it was called. Always succeeds.',
    parameters: { type: 'object', properties: { note: { type: 'string' } } },
    handler: async () => {
      calls.n += 1;
      return `probe ${calls.n}`;
    },
  };
}

function failingTool(): ConformanceTool {
  return {
    name: 'explode',
    description: 'Always throws.',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      throw new Error('the tool exploded');
    },
  };
}

const typesOf = (events: SquadEvent[]): string[] => events.map((e) => String(e.type));

/**
 * Run the contract against one harness.
 *
 * Every clause is checked independently and a failure never stops the rest:
 * knowing that a harness breaks four clauses is more useful than knowing it
 * broke the first one.
 */
export async function checkHarnessConformance(
  harness: string,
  ctx: ConformanceContext,
): Promise<ConformanceReport> {
  const clauses: ClauseResult[] = [];
  const record = (clause: string, because: string, ok: boolean, detail?: string) =>
    clauses.push({ clause, because, ok, ...(detail ? { detail } : {}) });

  // --- 1. lifecycle -------------------------------------------------------
  ctx.reset();
  try {
    const calls = { n: 0 };
    const session = await ctx.createSession({
      agentName: 'Prober',
      tools: [loopingTool(calls)],
      systemMessage: { mode: 'replace', content: 'Call the probe tool once, then reply with one word.' },
      maxToolRounds: TOOL_ROUND_BUDGET,
    });
    await (session.sendAndWait
      ? session.sendAndWait({ prompt: 'Call probe once.' }, 60_000)
      : session.sendMessage({ prompt: 'Call probe once.' }));

    const types = typesOf(ctx.events());
    // `session:created` and `session:destroyed` are deliberately **not** part
    // of this contract. Running the suite against the real backends showed both
    // failing them, and the backends were right: fan-out emits the lifecycle
    // pair around whatever session factory it was handed, so those events are
    // constant across harnesses and are not a harness's to provide. Asserting
    // them here would have made every conforming harness look broken — a
    // contract that cries wolf gets switched off.
    record(
      'gives every session a stable id',
      'fan-out correlates its lifecycle events, and the recorder its ADP sessions, by this id. A harness that changes it mid-turn splits one agent across two trajectories.',
      typeof session.sessionId === 'string' && session.sessionId.length > 0,
      `sessionId: ${JSON.stringify(session.sessionId)}`,
    );
    record(
      'reports token usage',
      'Cost and token comparisons come from session:model_usage. A harness that omits it reports every run as free.',
      types.includes('session:model_usage'),
    );
    record(
      'reports each tool call',
      'session:tool_call is the tool ground truth the summary splits registered from built-in on.',
      types.includes('session:tool_call'),
      `saw ${JSON.stringify([...new Set(types)])}`,
    );
  } catch (err) {
    record('completes a simple tool-using turn', 'The baseline: a harness that cannot do this cannot run a variant.', false, String((err as Error).message));
  }

  // --- 2. the turn resolves on completion, not on dispatch ----------------
  ctx.reset();
  try {
    const calls = { n: 0 };
    const session = await ctx.createSession({
      agentName: 'Prober',
      tools: [loopingTool(calls)],
      systemMessage: { mode: 'replace', content: 'Call the probe tool once, then reply with one word.' },
      maxToolRounds: TOOL_ROUND_BUDGET,
    });
    if (session.sendAndWait) {
      await session.sendAndWait({ prompt: 'Call probe once.' }, 60_000);
      // Not "did a tool run" — a dispatch-only harness can still have run one
      // synchronously before returning. The property is whether work carried on
      // *after* the turn reported itself finished.
      const atResolve = calls.n;
      await new Promise((r) => setTimeout(r, 300));
      const afterSettling = calls.n;
      record(
        'sendAndWait resolves only after the tools have run',
        'It is the quiescence signal the whole lab is built on: run wall-clock, the recorder flush barrier, and when the work repo is safe to commit all key off it.',
        atResolve > 0 && afterSettling === atResolve,
        `probe ran ${atResolve} time(s) by the time the turn resolved, ${afterSettling} shortly after`,
      );
    } else {
      record('offers sendAndWait', 'Without it there is no completion signal and the lab has to guess with a sleep.', false);
    }
  } catch (err) {
    record('sendAndWait resolves only after the tools have run', 'See above.', false, String((err as Error).message));
  }

  // --- 3. a failing tool is an event, not a crash -------------------------
  ctx.reset();
  try {
    const session = await ctx.createSession({
      agentName: 'Prober',
      tools: [failingTool()],
      systemMessage: { mode: 'replace', content: 'Call the explode tool once, then reply with one word.' },
      maxToolRounds: TOOL_ROUND_BUDGET,
    });
    await (session.sendAndWait
      ? session.sendAndWait({ prompt: 'Call explode once.' }, 60_000)
      : session.sendMessage({ prompt: 'Call explode once.' }));

    const toolEvents = ctx.events().filter((e) => String(e.type) === 'session:tool_call');
    const sawFailure = toolEvents.some(
      (e) => (e.payload as { resultType?: string })?.resultType && (e.payload as { resultType?: string }).resultType !== 'success',
    );
    record(
      'a throwing tool is reported as a failed tool call',
      'Tool failure rate is a headline comparison number. A harness that swallows failures reports a cleaner run than happened.',
      sawFailure,
      `resultTypes: ${JSON.stringify(toolEvents.map((e) => (e.payload as { resultType?: string })?.resultType))}`,
    );
  } catch (err) {
    record(
      'a throwing tool is reported as a failed tool call',
      'A tool that throws must not take the turn down with it.',
      false,
      String((err as Error).message),
    );
  }

  // --- 4. abort is honoured ------------------------------------------------
  ctx.reset();
  try {
    const session = await ctx.createSession({
      agentName: 'Prober',
      tools: [loopingTool({ n: 0 })],
      systemMessage: { mode: 'replace', content: 'Call probe repeatedly.' },
      maxToolRounds: 50,
    });
    if (session.abort) {
      const turn = session.sendAndWait
        ? session.sendAndWait({ prompt: 'Call probe over and over.' }, 60_000)
        : session.sendMessage({ prompt: 'Call probe over and over.' });
      await session.abort();
      await Promise.race([turn.catch(() => undefined), new Promise((r) => setTimeout(r, 15_000))]);
      record(
        'abort() ends the turn',
        'It is the deadline mechanism. A cooperative abort that no backend honours means a variant can only be stopped by killing the process.',
        true,
      );
    } else {
      record('offers abort()', 'Without it a hung turn can only be ended by killing the child.', false);
    }
  } catch {
    // An aborted turn rejecting is a legitimate implementation of abort.
    record('abort() ends the turn', 'See above.', true, 'the turn rejected, which is a valid abort');
  }

  // --- 5. the tool-round budget, which is the clause that matters ---------
  ctx.reset();
  const calls = { n: 0 };
  try {
    const session = await ctx.createSession({
      agentName: 'Prober',
      tools: [loopingTool(calls)],
      systemMessage: {
        mode: 'replace',
        content: 'Call the probe tool once per turn, forever. Never stop calling it.',
      },
      maxToolRounds: TOOL_ROUND_BUDGET,
    });
    await (session.sendAndWait
      ? session.sendAndWait({ prompt: 'Call probe repeatedly, forever.' }, 90_000)
      : session.sendMessage({ prompt: 'Call probe repeatedly, forever.' }));

    // Honoured at all: a harness with a *different* hidden ceiling is the
    // exact failure this suite was written for. One vendor stopped at ten
    // rounds while another ran unbounded, and the comparison between them was
    // meaningless in a way nothing surfaced.
    record(
      'honours the tool-round budget it was given',
      'Two harnesses with different round ceilings are not running the same experiment. This is the clause the Gemini/Anthropic comparison broke, silently.',
      calls.n <= TOOL_ROUND_BUDGET + 1,
      `probe ran ${calls.n} times against a budget of ${TOOL_ROUND_BUDGET}`,
    );

    // And exhausting it is an *outcome*, not a crash: a run stopped by a
    // budget is unscored-but-explained, where a crash is just an empty row.
    const errors = ctx.events().filter((e) => String(e.type) === 'session:error');
    const looksLikeACrash = errors.some((e) =>
      /exceeded|depth|loop/i.test(String((e.payload as { error?: string })?.error ?? '')),
    );
    record(
      'reports budget exhaustion as a milestone, not a session error',
      'A variant stopped by its budget and one that crashed look identical in the summary — an empty row — unless the harness distinguishes them.',
      !looksLikeACrash,
      looksLikeACrash ? `error events: ${JSON.stringify(errors.map((e) => (e.payload as { error?: string })?.error))}` : undefined,
    );
  } catch (err) {
    const message = String((err as Error).message);
    // A throw is itself a way of honouring a ceiling, so the budget clause is
    // judged on the numbers rather than on whether it threw...
    record(
      'honours the tool-round budget it was given',
      'Two harnesses with different round ceilings are not running the same experiment. This is the clause the Gemini/Anthropic comparison broke, silently.',
      calls.n <= TOOL_ROUND_BUDGET + 1,
      `probe ran ${calls.n} times against a budget of ${TOOL_ROUND_BUDGET}, then the turn threw: ${message}`,
    );
    // ...and the reporting clause is judged separately, because throwing is
    // exactly how a spent budget gets mistaken for a malfunction.
    record(
      'reports budget exhaustion as a milestone, not a session error',
      'A variant stopped by its budget and one that crashed look identical in the summary — an empty row — unless the harness distinguishes them.',
      false,
      `the turn threw rather than stopping cleanly: ${message}`,
    );
  }

  return {
    harness,
    passed: clauses.filter((c) => c.ok).length,
    failed: clauses.filter((c) => !c.ok).length,
    clauses,
  };
}

/** Human-readable report. Failures print why the clause exists. */
export function formatConformance(report: ConformanceReport): string {
  const lines = [`harness: ${report.harness} — ${report.passed} passed, ${report.failed} failed`];
  for (const c of report.clauses) {
    lines.push(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.clause}${c.detail ? ` — ${c.detail}` : ''}`);
    if (!c.ok) lines.push(`       why: ${c.because}`);
  }
  return lines.join('\n');
}
