/**
 * The Squad×ADP vertical slice, end to end against a live ADP server.
 *
 *   One Squad assignment creates an ADP run; each agent becomes an ADP session;
 *   every message, model call, tool execution, handoff, commit, and test result
 *   is durably appended; the run closes against a final Git SHA; a deterministic
 *   eval result is attached to that run and reported as gate evidence.
 *
 * Runs only when pointed at a live server, and is otherwise skipped:
 *
 *   SQUAD_ADP_TEST_API_URL=http://localhost:<port>
 *   SQUAD_ADP_TEST_TOKEN=<bootstrapped token>
 *   SQUAD_ADP_TEST_REPO=<owner>/<repo>   (must already exist, empty is fine)
 *
 * Deliberately lighter setup than `adp-platform-integration.test.ts`: that test
 * exists to prove the *`gh`-mediated* path works against ADP, and needs a TLS
 * proxy and a pinned `gh` binary to do it honestly. This one exercises the run,
 * trajectory, and eval surfaces, which have no GitHub analogue and are reached
 * over ADP's own REST API — so re-staging the `gh` harness here would cost setup
 * without testing anything the other file doesn't already cover. The assignment
 * still arrives as an issue, which is what a Squad WorkItem is.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../packages/squad-sdk/src/runtime/event-bus.js';
import { AdpClient } from '../packages/squad-sdk/src/adp/client.js';
import { AdpRunRecorder } from '../packages/squad-sdk/src/adp/recorder.js';

function skipReason(): string | null {
  const required = ['SQUAD_ADP_TEST_API_URL', 'SQUAD_ADP_TEST_TOKEN', 'SQUAD_ADP_TEST_REPO'];
  const missing = required.filter((name) => !process.env[name]);
  return missing.length > 0 ? `not configured against a live ADP server (missing ${missing.join(', ')})` : null;
}

const SKIP_REASON = skipReason();

describe.skipIf(SKIP_REASON !== null)(
  `Squad assignment recorded as an ADP run (${SKIP_REASON ?? 'enabled'})`,
  () => {
    let apiUrl: string;
    let token: string;
    let owner: string;
    let repo: string;
    let client: AdpClient;
    let bus: EventBus;
    let recorder: AdpRunRecorder;
    let intentId: string;
    let issueNumber: number;
    let finalSha: string;
    let workdir: string;
    let spoolRoot: string;
    const recorderErrors: { error: Error; context: string }[] = [];

    async function rest(method: string, path: string, body?: unknown): Promise<any> {
      const res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
      return text ? JSON.parse(text) : null;
    }

    function git(args: string[]): string {
      return execFileSync('git', args, { cwd: workdir, encoding: 'utf8' }).trim();
    }

    beforeAll(async () => {
      if (SKIP_REASON) return;
      apiUrl = process.env.SQUAD_ADP_TEST_API_URL!.replace(/\/$/, '');
      token = process.env.SQUAD_ADP_TEST_TOKEN!;
      [owner, repo] = process.env.SQUAD_ADP_TEST_REPO!.split('/') as [string, string];

      client = new AdpClient({ baseUrl: apiUrl, token, owner, repo });
      bus = new EventBus();

      // The assignment. A Squad WorkItem is an issue, and ADP turns every issue
      // into an intent at the moment it is filed — so the run has a stated goal
      // without anyone inventing one for it.
      const issue = await rest('POST', `/api/v3/repos/${owner}/${repo}/issues`, {
        title: 'Add a greeting module',
        body: 'with tests',
      });
      issueNumber = issue.number;
      intentId = issue.intent_id;

      spoolRoot = mkdtempSync(join(tmpdir(), 'squad-adp-spool-'));
      recorder = new AdpRunRecorder({
        client,
        intentId,
        externalRef: `issue:${issueNumber}`,
        batchSize: 4,
        flushIntervalMs: 50,
        // Durable buffer plus emitter numbering: this is the half of the
        // guarantee the server cannot supply on its own.
        spoolRoot,
        onError: (error, context) => recorderErrors.push({ error, context }),
      });
      await recorder.start(bus);

      workdir = mkdtempSync(join(tmpdir(), 'squad-adp-run-'));
      const cloneUrl = `${apiUrl.replace(/^(https?:\/\/)/, `$1x-access-token:${token}@`)}/${owner}/${repo}.git`;
      execFileSync('git', ['clone', cloneUrl, workdir], { stdio: 'pipe' });
      git(['checkout', '-B', 'main']);
      git(['config', 'user.email', 'squad@example.com']);
      git(['config', 'user.name', 'Squad']);
    }, 120_000);

    it('opens one run for the assignment', () => {
      expect(recorder.runId).toBeTruthy();
    });

    it('records the assignment as a full multi-agent trajectory', async () => {
      // A coordinator routing to two agents, each doing work. These are the
      // events Squad's own EventBus emits, in the shapes it emits them.
      await bus.emit({
        type: 'coordinator:routing',
        payload: { phase: 'routed', agents: ['Backend', 'Tester'], confidence: 'high', reason: 'implement then verify' },
        timestamp: new Date(),
      });
      await bus.emit({
        type: 'session:created',
        sessionId: 'squad-backend',
        agentName: 'Backend',
        payload: { agentName: 'Backend', priority: 'normal' },
        timestamp: new Date(),
      });
      await bus.emit({
        type: 'session:message',
        sessionId: 'squad-backend',
        agentName: 'Backend',
        payload: { message: 'writing greeting.js', role: 'assistant', content: 'writing greeting.js' },
        timestamp: new Date(),
      });
      await bus.emit({
        type: 'session:tool_call',
        sessionId: 'squad-backend',
        agentName: 'Backend',
        payload: { toolName: 'Write', toolArgs: { path: 'greeting.js' }, resultType: 'success' },
        timestamp: new Date(),
      });
      await bus.emit({
        type: 'session:tool_call',
        sessionId: 'squad-backend',
        agentName: 'Backend',
        payload: { toolName: 'Bash', toolArgs: { command: 'node -e require' }, resultType: 'failure' },
        timestamp: new Date(),
      });
      await recorder.recordModelCall('Backend', {
        model: 'claude-opus-5',
        tokensIn: 1200,
        tokensOut: 300,
        costMicroUsd: 9000,
        durationMs: 2400,
      });

      // A real commit, pushed to the real server, whose sha the run will close
      // against — the trajectory joins to the change record by sha, not by a
      // string in a payload.
      writeFileSync(join(workdir, 'greeting.js'), "module.exports = () => 'hello';\n");
      git(['add', '.']);
      git(['commit', '-m', 'feat: greeting module']);
      git(['push', 'origin', 'main']);
      finalSha = git(['rev-parse', 'HEAD']);
      await recorder.recordCommit('Backend', finalSha, { message: 'feat: greeting module' });

      await bus.emit({
        type: 'session:created',
        sessionId: 'squad-tester',
        agentName: 'Tester',
        payload: { agentName: 'Tester', priority: 'normal' },
        timestamp: new Date(),
      });
      await recorder.recordModelCall('Tester', {
        model: 'claude-sonnet-5',
        tokensIn: 800,
        tokensOut: 150,
        costMicroUsd: 1200,
        durationMs: 1100,
      });
      await recorder.recordTestResult('Tester', {
        suite: 'vitest',
        passed: true,
        durationMs: 5300,
        gitSha: finalSha,
        details: { passed: 4, failed: 0 },
      });
      await bus.emit({
        type: 'session:destroyed',
        sessionId: 'squad-tester',
        agentName: 'Tester',
        payload: { agentName: 'Tester', reason: 'complete' },
        timestamp: new Date(),
      });

      await recorder.flush();
      expect(recorderErrors).toEqual([]);

      const trajectory = await client.getTrajectory(recorder.runId!, { limit: 200 });
      const kinds = new Set((trajectory.events as { kind: string }[]).map((e) => e.kind));
      // Every kind the capability statement names, recorded durably.
      expect(kinds).toContain('message');
      expect(kinds).toContain('model_call');
      expect(kinds).toContain('tool_call');
      expect(kinds).toContain('handoff');
      expect(kinds).toContain('commit');
      expect(kinds).toContain('test_result');

      // Every event carries the emitter's own number, contiguous per session.
      // This is what the append acknowledgement (`accepted_through`) advances
      // against, and what makes a dropped batch detectable rather than merely
      // unlikely.
      const bySession = new Map<string, number[]>();
      for (const event of trajectory.events as { session_id: string; producer_seq: number }[]) {
        bySession.set(event.session_id, [...(bySession.get(event.session_id) ?? []), event.producer_seq]);
      }
      expect(bySession.size).toBeGreaterThan(0);
      for (const seqs of bySession.values()) {
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs.map((_, i) => i + 1));
      }
    }, 120_000);

    it('exposes the handoff graph and the cost of the run', async () => {
      const stats = (await client.getStats(recorder.runId!)) as any;
      expect(stats.sessions).toBe(3); // coordinator + Backend + Tester
      expect(stats.tokensIn).toBe(2000);
      expect(stats.costMicroUsd).toBe(10200);
      expect(stats.commits).toContain(finalSha);

      const targets = stats.handoffs.map((h: { to: string }) => h.to).sort();
      expect(targets).toEqual(
        [recorder.sessionsByAgent.get('Backend')!, recorder.sessionsByAgent.get('Tester')!].sort(),
      );

      const bash = stats.tools.find((t: { name: string }) => t.name === 'Bash');
      expect(bash.failures).toBe(1);
    });

    it('closes the run against the final sha, with a verifiable attestation', async () => {
      const closed = await recorder.close(finalSha);
      expect(closed.status).toBe('closed');
      expect(closed.final_git_sha).toBe(finalSha);
      expect(closed.trajectory_digest).toBeTruthy();
      expect(closed.envelope).toBeTruthy();

      const verified = (await client.verifyRun(recorder.runId!)) as any;
      expect(verified.ok).toBe(true);
      expect(verified.chains_ok).toBe(true);
      expect(verified.envelope_verified).toBe(true);

      // Recorder completeness, as the server sees it: every session the
      // recorder wrote to is tracked and whole. `chains_ok` alone would pass on
      // a trajectory that was never fully delivered.
      expect(verified.emitters_ok).toBe(true);
      for (const session of verified.sessions as { emitter_tracked: boolean; emitter_complete: boolean }[]) {
        expect(session.emitter_tracked).toBe(true);
        expect(session.emitter_complete).toBe(true);
      }

      // And the spool is gone, because ADP has attested to what it held.
      expect(existsSync(recorder.spoolPath ?? spoolRoot)).toBe(false);
    });

    it('attaches a deterministic eval that lands as gate evidence on the commit', async () => {
      const recorded = await recorder.recordEval({
        name: 'behavior',
        passed: true,
        score: 0.92,
        spec: { suite: 'greeting-behavior', cases: 12, seed: 7 },
      });
      expect(recorded.git_sha).toBe(finalSha);
      expect(recorded.spec_digest).toHaveLength(64);

      // Reported as ordinary gate evidence — readable through the compat-plane
      // gates endpoint, with no eval-specific path.
      const gates = await rest('GET', `/api/v3/repos/${owner}/${repo}/commits/${finalSha}/gates`);
      expect((gates as { name: string }[]).map((g) => g.name)).toContain('score');

      const evidence = await rest('GET', `/api/adp/repos/${owner}/${repo}/evidence/${finalSha}`);
      expect(evidence.gates.map((g: { name: string }) => g.name)).toContain('score');
    });

    it('ranks a second attempt at the same assignment against the first', async () => {
      // A second run against the same intent — the shape a candidate-set fan-out
      // takes, and the reason recording trajectories pays for itself.
      const second = new AdpRunRecorder({
        client,
        intentId,
        externalRef: `issue:${issueNumber}-attempt-2`,
        batchSize: 10,
      });
      await second.start(bus);
      await second.recordModelCall('Backend', {
        model: 'claude-opus-5',
        tokensIn: 9000,
        tokensOut: 4000,
        costMicroUsd: 88000,
      });
      await second.close(finalSha);
      await second.recordEval({ name: 'behavior', passed: false, score: 0.41, spec: { suite: 'greeting-behavior' } });

      const compared = await client.compareRuns({ intentId, evalName: 'behavior' });
      const scored = compared.runs.filter((r: any) => r.eval !== null);
      expect(scored[0].runId).toBe(recorder.runId);
      expect((scored[0] as any).eval.score).toBe(0.92);
      expect(scored[1].runId).toBe(second.runId);
      // The better-scoring attempt was also the cheaper one — the pairing this
      // whole slice exists to make queryable.
      expect(Number(scored[0].costMicroUsd)).toBeLessThan(Number(scored[1].costMicroUsd));

      rmSync(workdir, { recursive: true, force: true });
      rmSync(spoolRoot, { recursive: true, force: true });
    }, 120_000);
  },
);
