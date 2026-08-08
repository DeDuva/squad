/**
 * The trial runner, and the hazard it exists to remove.
 *
 * squad-lab drives agents through `SquadCoordinator.handleMessage`, which runs
 * `shouldHandleDirectly()` before it routes. When a built-in pattern matches,
 * the coordinator answers the message itself: no agent spawned, no tool called,
 * an empty trajectory — and `run-variant.ts` never inspects `result.strategy`,
 * so that run closes and looks like every other run in the comparison.
 *
 * The first test below is not about duva-bench at all. It pins the hazard as a
 * live fact about the SDK on this branch, using real task titles, because the
 * argument for a coordinator-free runner is only as good as the claim that the
 * coordinator would have eaten these goals. Everything after it tests that the
 * runner is immune by construction rather than by configuration.
 *
 * The other two properties SG1 names are here too: a trial that produces no
 * commit — or throws — must still *finish* its recording rather than leave an
 * open run stranded, and the terminal `session:destroyed` must actually reach
 * the recorder, because that is what flushes the session's chain.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DirectResponseHandler } from '../packages/squad-sdk/src/coordinator/direct-response.js';
import { EventBus, type SquadEvent } from '../packages/squad-sdk/src/runtime/event-bus.js';
import { AdpRunRecorder } from '../packages/squad-sdk/src/adp/recorder.js';
import { runTrial, type TrialDeps, type TrialSpec } from '../packages/duva-bench/src/runner.js';
import { generateTwin } from '../packages/duva-bench/src/twins.js';
import { defaultTools } from '../packages/squad-lab/src/tools/default.js';
import type { Workspace } from '../packages/squad-lab/src/isolate.js';

// ─── The hazard, as a fact about this branch ─────────────────────────────

describe('the coordinator hazard S1 removes', () => {
  /**
   * Ordinary benchmark task titles, each matching a built-in pattern.
   *
   * These are not contrived. "Config loader should merge defaults" is the kind
   * of thing a seed repo's `goal.md` says, and `/^config\b/i` swallows it.
   */
  const swallowed = [
    'Config loader should merge defaults',
    'Help text should wrap at 80 columns',
    'List the team members endpoint',
    'Show the config schema for the parser',
    'Status bar should render the branch name',
  ];

  it.each(swallowed)('the coordinator would answer %j itself, spawning no agent', (title) => {
    expect(new DirectResponseHandler().shouldHandleDirectly(title)).toBe(true);
  });

  it('leaves ordinary phrasing alone, so the hazard is silent rather than obvious', () => {
    // The trap is that it fires for *some* titles. A runner that only broke
    // loudly would have been caught years ago.
    expect(new DirectResponseHandler().shouldHandleDirectly('Add a retry to the fetch helper')).toBe(
      false,
    );
  });
});

// ─── Fixtures ────────────────────────────────────────────────────────────

interface Harness {
  spec: TrialSpec;
  events: SquadEvent[];
  calls: {
    createSession: number;
    prompts: string[];
    flushes: number;
    finished: Array<{ finalGitSha?: string | null; reason?: string }>;
    charters: string[];
    toolNames: string[][];
  };
  cleanup: () => void;
}

function harness(overrides: {
  goalTitle?: string;
  sha?: string | null;
  deps?: Partial<TrialDeps>;
  spec?: Partial<TrialSpec>;
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'duvabench-trial-'));
  const events: SquadEvent[] = [];
  const calls: Harness['calls'] = {
    createSession: 0,
    prompts: [],
    flushes: 0,
    finished: [],
    charters: [],
    toolNames: [],
  };

  const workspace: Workspace = { workDir: dir, branch: 'trial', remote: 'http://adp.invalid/x.git' };

  const recorder = {
    runId: 'run-abc',
    sessionsByAgent: new Map([['solver', 'adp-session-1']]),
    flush: async () => {
      calls.flushes += 1;
    },
    recordCommit: async () => {},
    recordTestResult: async () => {},
  };

  const deps: TrialDeps = {
    prepareWorkspace: () => workspace,
    commitAndPush: () => (overrides.sha === undefined ? 'deadbeef' : overrides.sha),
    openArm: async () => ({
      model: 'test-model',
      close: async () => {},
      createSession: async (config) => {
        calls.createSession += 1;
        calls.charters.push(String(config.systemMessage?.content ?? ''));
        calls.toolNames.push((config.tools ?? []).map((t) => t.name));
        return {
          sessionId: 'squad-session-1',
          sendAndWait: async (opts: { prompt: string }) => {
            calls.prompts.push(opts.prompt);
            // A real turn puts work on the bus; this stands in for it so the
            // lifecycle events have something to bracket.
            await (config as { tools?: unknown[] }).tools?.length;
            return 'ok';
          },
          sendMessage: async () => {},
          abort: async () => {},
        };
      },
    }),
    startRecording: async () => recorder as unknown as AdpRunRecorder,
    finishRecording: async (_rec, outcome) => {
      calls.finished.push(outcome);
    },
    readGoal: async () => ({
      title: overrides.goalTitle ?? 'Add a retry to the fetch helper',
      body: 'Body of the goal.',
    }),
    verifyRun: async () => ({ ok: true }),
    runSuite: () => null,
    ...overrides.deps,
  };

  const spec: TrialSpec = {
    externalRef: 'study:arm:task:r1',
    arm: { id: 'arm-a', harness: 'ai-sdk', provider: 'anthropic' },
    adp: {
      baseUrl: 'http://adp.invalid',
      token: 'unused',
      owner: 'o',
      repo: 'r',
      issueNumber: 1,
      intentId: 'intent-1',
      tokenEnv: 'SQUAD_LAB_ADP_TOKEN',
    },
    workspace: { workDir: dir, seedRepo: dir, branch: 'trial' },
    agent: { name: 'solver', prompt: 'Solve it. Make no further tool calls.' },
    outDir: join(dir, 'out'),
    deps,
    onEvent: (e) => events.push(e),
    ...overrides.spec,
  };

  return { spec, events, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const typesOf = (events: SquadEvent[]) => events.map((e) => e.type);

// ─── The runner ──────────────────────────────────────────────────────────

describe('runTrial', () => {
  it('spawns an agent for a goal the coordinator would have answered itself', async () => {
    const title = 'Config loader should merge defaults';
    expect(new DirectResponseHandler().shouldHandleDirectly(title)).toBe(true);

    const h = harness({ goalTitle: title });
    try {
      const result = await runTrial(h.spec);

      // The claim in full: an agent was created, and it was sent this goal.
      expect(h.calls.createSession).toBe(1);
      expect(h.calls.prompts).toHaveLength(1);
      expect(h.calls.prompts[0]).toContain(title);
      expect(result.outcome).toBe('closed');
    } finally {
      h.cleanup();
    }
  });

  it('brackets the turn with the lifecycle events fan-out used to emit', async () => {
    const h = harness();
    try {
      await runTrial(h.spec);

      const lifecycle = h.events.filter((e) => e.type.startsWith('session:'));
      expect(typesOf(lifecycle)).toEqual(['session:created', 'session:destroyed']);

      // Both must name the agent: the recorder resolves an unmapped session by
      // agent name, and an anonymous terminal event is one the recorder drops
      // — taking the flush it was supposed to trigger with it.
      for (const event of lifecycle) {
        expect(event.agentName).toBe('solver');
        expect(event.sessionId).toBe('squad-session-1');
      }
    } finally {
      h.cleanup();
    }
  });

  it('emits the terminal event before it asks the recorder to flush', async () => {
    const order: string[] = [];
    const h = harness({
      deps: {
        startRecording: async () =>
          ({
            runId: 'run-abc',
            sessionsByAgent: new Map(),
            flush: async () => order.push('flush'),
            recordCommit: async () => {},
            recordTestResult: async () => {},
          }) as unknown as AdpRunRecorder,
      },
    });
    h.spec.onEvent = (e) => {
      if (e.type === 'session:destroyed') order.push('destroyed');
    };
    try {
      await runTrial(h.spec);
      expect(order[0]).toBe('destroyed');
      expect(order).toContain('flush');
    } finally {
      h.cleanup();
    }
  });

  it('abandons rather than closes when the agent produced no commit', async () => {
    const h = harness({ sha: null });
    try {
      const result = await runTrial(h.spec);

      expect(result.outcome).toBe('abandoned');
      expect(result.finalSha).toBeNull();
      expect(h.calls.finished).toEqual([
        { finalGitSha: null, reason: 'agent produced no commit' },
      ]);
    } finally {
      h.cleanup();
    }
  });

  it('finishes the recording even when the trial throws, so no run is stranded', async () => {
    const h = harness({
      deps: {
        openArm: async () => {
          throw new Error('vendor key rejected');
        },
      },
    });
    try {
      const result = await runTrial(h.spec);

      expect(result.outcome).toBe('error');
      expect(result.error).toBe('vendor key rejected');
      expect(h.calls.finished).toEqual([{ finalGitSha: null, reason: 'vendor key rejected' }]);
    } finally {
      h.cleanup();
    }
  });

  it('abandons on a deadline instead of closing against a half-finished tree', async () => {
    const h = harness({
      spec: { limits: { turnTimeoutMs: 5, deadlineMs: 10, graceMs: 1 } },
      deps: {
        openArm: async () => ({
          model: 'test-model',
          close: async () => {},
          createSession: async () => ({
            sessionId: 'squad-session-1',
            sendAndWait: () => new Promise<string>(() => {}),
            sendMessage: async () => {},
            abort: async () => {},
          }),
        }),
      },
    });
    try {
      const result = await runTrial(h.spec);

      expect(result.outcome).toBe('timeout');
      // A sha existed, and is deliberately not what the run closed against: the
      // tree at a deadline is whatever the agent happened to have written.
      expect(h.calls.finished).toEqual([{ finalGitSha: null, reason: 'deadline' }]);
    } finally {
      h.cleanup();
    }
  });

  it('writes trial.json with pointers and a verdict, not scores', async () => {
    const h = harness();
    try {
      const result = await runTrial(h.spec);
      const onDisk = JSON.parse(readFileSync(join(h.spec.outDir, 'trial.json'), 'utf8'));

      expect(onDisk).toEqual(result);
      expect(onDisk.runId).toBe('run-abc');
      expect(onDisk.verified).toBe(true);
      expect(existsSync(join(h.spec.outDir, 'bus.jsonl'))).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe('runTrial verification', () => {
  it("reports ADP's verdict rather than the fact that it closed the run", async () => {
    const h = harness({ deps: { verifyRun: async () => ({ ok: false, reason: 'chain broken' }) } });
    try {
      const result = await runTrial(h.spec);
      expect(result.outcome).toBe('closed');
      expect(result.verified).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('distinguishes "could not check" from "does not hold up"', async () => {
    const h = harness({
      deps: {
        verifyRun: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });
    try {
      const result = await runTrial(h.spec);
      // null, never false. A gate that conflated the two would either reject
      // healthy runs or accept tampered ones.
      expect(result.verified).toBeNull();
      expect(result.verifyDetail).toEqual({ error: 'ECONNREFUSED' });
    } finally {
      h.cleanup();
    }
  });
});

// ─── The recorder's half of the contract ─────────────────────────────────

describe('session:destroyed flushes the session chain', () => {
  it('sends the buffered events for that session when the terminal event lands', async () => {
    const appended: Array<{ sessionId: string; count: number }> = [];
    const client = {
      openRun: async () => ({ id: 'run-1' }),
      startSession: async () => ({ id: 'adp-session-1' }),
      appendEvents: async (sessionId: string, batch: unknown[]) => {
        appended.push({ sessionId, count: batch.length });
      },
      closeRun: async () => ({}),
      abandonRun: async () => ({}),
      recordEval: async () => ({}),
    };

    const spool = mkdtempSync(join(tmpdir(), 'duvabench-spool-'));
    const bus = new EventBus();
    const recorder = new AdpRunRecorder({
      client: client as never,
      intentId: 'intent-1',
      externalRef: 'ref-1',
      spoolRoot: spool,
    } as never);

    try {
      await recorder.start(bus);

      await bus.emit({
        type: 'session:created',
        sessionId: 'squad-1',
        agentName: 'solver',
        payload: { agentName: 'solver' },
        timestamp: new Date(),
      } as never);
      await bus.emit({
        type: 'session:message',
        sessionId: 'squad-1',
        agentName: 'solver',
        payload: { role: 'assistant', content: 'working' },
        timestamp: new Date(),
      } as never);

      // Nothing has been sent yet — the recorder batches.
      const beforeDestroy = appended.length;

      await bus.emit({
        type: 'session:destroyed',
        sessionId: 'squad-1',
        agentName: 'solver',
        payload: { reason: 'turn complete' },
        timestamp: new Date(),
      } as never);
      await recorder.flush();

      expect(appended.length).toBeGreaterThan(beforeDestroy);
      expect(appended.every((a) => a.sessionId === 'adp-session-1')).toBe(true);
    } finally {
      rmSync(spool, { recursive: true, force: true });
    }
  });
});

// ─── The toolset the agent actually meets ────────────────────────────────

describe('runTrial toolsets', () => {
  it('gives the agent the standard tools and a reference bundle by default', async () => {
    const h = harness();
    try {
      const result = await runTrial(h.spec);
      expect(h.calls.toolNames[0]).toEqual(defaultTools('/tmp/x').map((t) => t.name));
      expect(result.docsGrade).toBe('reference');
      // The charter carries the docs — that is the injection channel, and
      // `harnessDigest` folds the charter, so being told more is visibly a
      // different harness.
      expect(h.calls.charters[0]).toContain(h.spec.agent.prompt);
      expect(h.calls.charters[0]).toContain('Tools available to you');
    } finally {
      h.cleanup();
    }
  });

  it('hands over twin names, and no original name survives into the charter', async () => {
    const h = harness({ spec: { toolset: { twinSeed: 'study-a', docsGrade: 'rich' } } });
    try {
      const result = await runTrial(h.spec);
      const { renameMap } = generateTwin(defaultTools('/tmp/x'), 'study-a');

      expect(h.calls.toolNames[0]).toEqual(Object.values(renameMap.tools));
      for (const original of Object.keys(renameMap.tools)) {
        // A charter mentioning `write_file` would hand back exactly the
        // familiarity the twin exists to remove.
        expect(h.calls.charters[0]).not.toContain(original);
      }
      expect(result.docsGrade).toBe('rich');
    } finally {
      h.cleanup();
    }
  });

  it('says nothing at all at grade none', async () => {
    const h = harness({ spec: { toolset: { twinSeed: 'study-a', docsGrade: 'none' } } });
    try {
      await runTrial(h.spec);
      expect(h.calls.charters[0]).toBe(h.spec.agent.prompt);
    } finally {
      h.cleanup();
    }
  });

  it('persists the rename map, without which the trajectory cannot be read', async () => {
    const h = harness({ spec: { toolset: { twinSeed: 'study-a', docsGrade: 'none' } } });
    try {
      await runTrial(h.spec);
      const onDisk = JSON.parse(readFileSync(join(h.spec.outDir, 'rename-map.json'), 'utf8'));
      expect(onDisk.seed).toBe('study-a');
      expect(Object.keys(onDisk.tools).sort()).toEqual(defaultTools('/tmp/x').map((t) => t.name).sort());
    } finally {
      h.cleanup();
    }
  });

  it('writes no rename map for an untwinned arm', async () => {
    const h = harness();
    try {
      await runTrial(h.spec);
      expect(existsSync(join(h.spec.outDir, 'rename-map.json'))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('gives the two docs grades different digests on the run', async () => {
    const none = harness({ spec: { toolset: { docsGrade: 'none' } } });
    const rich = harness({ spec: { toolset: { docsGrade: 'rich' } } });
    try {
      const a = await runTrial(none.spec);
      const b = await runTrial(rich.spec);
      expect(a.toolDocsDigest).not.toBe(b.toolDocsDigest);
    } finally {
      none.cleanup();
      rich.cleanup();
    }
  });
});

// ─── Resuming into your own leftovers ────────────────────────────────────

describe('a resumed trial', () => {
  it('clears a stale work directory that a killed run left behind', async () => {
    // The bug this encodes: `git clone` refuses a destination that is not
    // empty, so after a study is killed every retried trial fails on a stale
    // directory rather than on anything real. Resumption is the whole point of
    // the scheduler, and it met its own leftovers on the first real study.
    const h = harness();
    try {
      const workDir = join(h.spec.outDir, 'work');
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, 'leftover.txt'), 'from the run that died\n');
      h.spec.workspace = { ...h.spec.workspace, workDir };

      let sawEmpty = false;
      h.spec.deps = {
        ...h.spec.deps,
        prepareWorkspace: (workspaceSpec) => {
          sawEmpty = !existsSync(workspaceSpec.workDir);
          return { workDir: workspaceSpec.workDir, branch: 'trial', remote: 'http://adp.invalid/x.git' };
        },
      };

      await runTrial(h.spec);
      expect(sawEmpty).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('never deletes a work directory outside the trial it owns', async () => {
    // Bounded on purpose. The runner created the path under its own outDir, so
    // it is the runner's to clear; anything else is somebody's checkout.
    const h = harness();
    const outside = mkdtempSync(join(tmpdir(), 'duvabench-not-ours-'));
    try {
      writeFileSync(join(outside, 'precious.txt'), 'do not delete\n');
      h.spec.workspace = { ...h.spec.workspace, workDir: outside };
      h.spec.deps = {
        ...h.spec.deps,
        prepareWorkspace: () => ({ workDir: outside, branch: 'trial', remote: 'http://adp.invalid/x.git' }),
      };

      await runTrial(h.spec);
      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      h.cleanup();
    }
  });
});
