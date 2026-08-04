/**
 * Unit tests for the ADP trajectory recorder.
 *
 * Runs against an in-memory fake of ADP's native plane rather than a live
 * server, so the mapping from Squad's EventBus to ADP's event vocabulary is
 * pinned without needing containers. The live end-to-end walk lives in
 * `test/adp-run-trajectory-integration.test.ts`, which asserts the same
 * behaviour against a real server that actually hash-chains what it receives.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../packages/squad-sdk/src/runtime/event-bus.js';
import { AdpClient } from '../packages/squad-sdk/src/adp/client.js';
import { AdpRunRecorder } from '../packages/squad-sdk/src/adp/recorder.js';

interface AppendCall {
  sessionId: string;
  events: Record<string, any>[];
}

/** An in-memory stand-in for ADP's `/api/adp` surface. */
class FakeAdp {
  runs = new Map<string, { id: string; external_ref: string | null; status: string; final_git_sha: string | null }>();
  sessions = new Map<string, { id: string; harness: string; run_id: string }>();
  appends: AppendCall[] = [];
  /** Events that actually landed, per session, in order. */
  landed = new Map<string, Record<string, any>[]>();
  evals: Record<string, any>[] = [];
  /** Set to make the next N appends fail, the way a flaky network would. */
  failAppends = 0;
  private counter = 0;

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;

    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

    if (method === 'POST' && path.endsWith('/runs')) {
      // Mirrors ADP's idempotent open: an existing external_ref rejoins.
      const existing = [...this.runs.values()].find((r) => r.external_ref === (body.external_ref ?? null));
      if (existing) return json(200, existing);
      const run = { id: this.id('run'), external_ref: body.external_ref ?? null, status: 'open', final_git_sha: null };
      this.runs.set(run.id, run);
      return json(201, run);
    }

    if (method === 'POST' && path.endsWith('/sessions')) {
      const session = { id: this.id('session'), harness: body.harness, run_id: body.run_id };
      this.sessions.set(session.id, session);
      return json(201, session);
    }

    const appendMatch = path.match(/\/sessions\/([^/]+)\/events$/);
    if (method === 'POST' && appendMatch) {
      const sessionId = appendMatch[1]!;
      if (this.failAppends > 0) {
        this.failAppends -= 1;
        return json(503, { message: 'upstream unavailable' });
      }
      this.appends.push({ sessionId, events: body.events });
      const landed = this.landed.get(sessionId) ?? [];
      const seen = new Set(landed.map((e) => e.client_event_id));
      const duplicates: string[] = [];
      for (const event of body.events as Record<string, any>[]) {
        if (event.client_event_id && seen.has(event.client_event_id)) {
          duplicates.push(event.client_event_id);
          continue;
        }
        if (event.client_event_id) seen.add(event.client_event_id);
        landed.push(event);
      }
      this.landed.set(sessionId, landed);
      return json(201, { session_id: sessionId, appended: body.events.length - duplicates.length, duplicates, count: landed.length, head: 'head' });
    }

    const closeMatch = path.match(/\/runs\/([^/]+)\/close$/);
    if (method === 'POST' && closeMatch) {
      const run = this.runs.get(closeMatch[1]!)!;
      run.status = 'closed';
      run.final_git_sha = body.final_git_sha;
      return json(200, run);
    }

    const evalMatch = path.match(/\/runs\/([^/]+)\/evals$/);
    if (method === 'POST' && evalMatch) {
      const recorded = { id: this.id('eval'), run_id: evalMatch[1], ...body };
      this.evals.push(recorded);
      return json(201, recorded);
    }

    return json(404, { message: `unhandled ${method} ${path}` });
  };

  eventsFor(sessionId: string): Record<string, any>[] {
    return this.landed.get(sessionId) ?? [];
  }

  sessionByHarness(match: string): string {
    const found = [...this.sessions.values()].find((s) => s.harness.includes(match));
    if (!found) throw new Error(`no session with harness containing '${match}'`);
    return found.id;
  }
}

describe('AdpRunRecorder', () => {
  let adp: FakeAdp;
  let client: AdpClient;
  let bus: EventBus;
  let recorder: AdpRunRecorder;
  let errors: { error: Error; context: string }[];

  beforeEach(async () => {
    adp = new FakeAdp();
    client = new AdpClient({
      baseUrl: 'http://adp.test',
      token: 'token',
      owner: 'acme',
      repo: 'widget',
      fetchImpl: adp.fetch,
    });
    bus = new EventBus();
    errors = [];
    recorder = new AdpRunRecorder({
      client,
      intentId: 'intent-1',
      externalRef: 'issue:42',
      // Batch-of-one keeps these tests about mapping rather than about timers.
      batchSize: 1,
      onError: (error, context) => errors.push({ error, context }),
    });
    await recorder.start(bus);
  });

  it('opens one run for the assignment and a session for the coordinator', () => {
    expect(recorder.runId).toBe('run-1');
    expect(adp.runs.get('run-1')!.external_ref).toBe('issue:42');
    expect(adp.sessionByHarness('squad-coordinator')).toBeTruthy();
  });

  it('rejoins an existing run rather than opening a second one', async () => {
    const second = new AdpRunRecorder({ client, intentId: 'intent-1', externalRef: 'issue:42' });
    const run = await second.start(bus);
    expect(run.id).toBe('run-1');
    expect(adp.runs.size).toBe(1);
  });

  it('gives each agent its own session', async () => {
    await bus.emit({
      type: 'session:created',
      sessionId: 'squad-a',
      agentName: 'Backend',
      payload: { agentName: 'Backend', priority: 'normal' },
      timestamp: new Date('2026-08-04T10:00:00Z'),
    });
    await bus.emit({
      type: 'session:created',
      sessionId: 'squad-b',
      agentName: 'Tester',
      payload: { agentName: 'Tester', priority: 'normal' },
      timestamp: new Date('2026-08-04T10:00:01Z'),
    });
    await recorder.flush();

    expect(recorder.sessionsByAgent.get('Backend')).toBeTruthy();
    expect(recorder.sessionsByAgent.get('Tester')).toBeTruthy();
    expect(recorder.sessionsByAgent.get('Backend')).not.toBe(recorder.sessionsByAgent.get('Tester'));
  });

  it('maps messages and tool calls onto ADP kinds, carrying the outcome', async () => {
    await bus.emit({
      type: 'session:message',
      sessionId: 'squad-a',
      agentName: 'Backend',
      payload: { message: 'implementing', role: 'assistant', content: 'implementing' },
      timestamp: new Date('2026-08-04T10:00:02Z'),
    });
    await bus.emit({
      type: 'session:tool_call',
      sessionId: 'squad-a',
      agentName: 'Backend',
      payload: { toolName: 'Bash', toolArgs: { command: 'npm test' }, resultType: 'failure' },
      timestamp: new Date('2026-08-04T10:00:03Z'),
    });
    await recorder.flush();

    const events = adp.eventsFor(recorder.sessionsByAgent.get('Backend')!);
    expect(events.map((e) => e.kind)).toEqual(['message', 'tool_call']);
    expect(events[0].type).toBe('assistant');
    expect(events[1].type).toBe('Bash');
    // A failed tool call has to arrive as a failure, or "which tools cost this
    // fleet retries" cannot be answered from the trajectory.
    expect(events[1].status).toBe('failure');
    expect(events[1].payload).toEqual({ args: { command: 'npm test' } });
  });

  it('maps a denied tool call to rejected rather than to a failure', async () => {
    await bus.emit({
      type: 'session:tool_call',
      sessionId: 'squad-a',
      agentName: 'Backend',
      payload: { toolName: 'Write', toolArgs: {}, resultType: 'denied' },
      timestamp: new Date('2026-08-04T10:00:04Z'),
    });
    await recorder.flush();
    expect(adp.eventsFor(recorder.sessionsByAgent.get('Backend')!)[0].status).toBe('rejected');
  });

  it('records a model fallback as a failed model call, with the model that failed', async () => {
    await bus.emit({
      type: 'agent:milestone',
      sessionId: 'squad-a',
      agentName: 'Backend',
      payload: {
        event: 'model.fallback',
        agentName: 'Backend',
        failedModel: 'gemini-2.5-pro',
        failedTier: 'premium',
        error: 'rate limited',
        attemptNumber: 1,
      },
      timestamp: new Date('2026-08-04T10:00:05Z'),
    });
    await recorder.flush();

    const event = adp.eventsFor(recorder.sessionsByAgent.get('Backend')!)[0];
    expect(event.kind).toBe('model_call');
    expect(event.status).toBe('failure');
    expect(event.model).toBe('gemini-2.5-pro');
  });

  // Squad routes to an agent *before* spawning it. If the recorder only created
  // sessions on `session:created`, the handoff would have no target to name and
  // the edge would be lost — so this is the ordering that matters, not the
  // convenient one.
  it('resolves handoff edges when routing precedes the agent being spawned', async () => {
    await bus.emit({
      type: 'coordinator:routing',
      payload: { phase: 'routed', agents: ['Backend', 'Tester'], confidence: 'high', reason: 'split' },
      timestamp: new Date('2026-08-04T10:00:06Z'),
    });
    await recorder.flush();

    const coordinator = adp.sessionByHarness('squad-coordinator');
    const handoffs = adp.eventsFor(coordinator).filter((e) => e.kind === 'handoff');
    expect(handoffs).toHaveLength(2);
    expect(handoffs.map((h) => h.related_session_id).sort()).toEqual(
      [recorder.sessionsByAgent.get('Backend')!, recorder.sessionsByAgent.get('Tester')!].sort(),
    );

    // And the agent's own later events land in that same session rather than a
    // second one opened on `session:created`.
    await bus.emit({
      type: 'session:created',
      sessionId: 'squad-a',
      agentName: 'Backend',
      payload: { agentName: 'Backend', priority: 'normal' },
      timestamp: new Date('2026-08-04T10:00:07Z'),
    });
    await recorder.flush();
    expect(adp.sessions.size).toBe(3); // coordinator + Backend + Tester
  });

  it('drops pool health gauges, which are not things that happened', async () => {
    await bus.emit({
      type: 'pool:health',
      payload: { activeSessions: 2, availableSlots: 1, queuedRequests: 0 },
      timestamp: new Date('2026-08-04T10:00:08Z'),
    });
    await recorder.flush();
    expect(adp.appends).toHaveLength(0);
  });

  it('records commits and test results, which Squad does not emit', async () => {
    await recorder.recordCommit('Backend', 'a'.repeat(40), { message: 'feat: greeting' });
    await recorder.recordTestResult('Tester', { suite: 'vitest', passed: true, durationMs: 5300, gitSha: 'a'.repeat(40) });
    await recorder.flush();

    const commit = adp.eventsFor(recorder.sessionsByAgent.get('Backend')!)[0];
    expect(commit.kind).toBe('commit');
    expect(commit.git_sha).toBe('a'.repeat(40));

    const test = adp.eventsFor(recorder.sessionsByAgent.get('Tester')!)[0];
    expect(test.kind).toBe('test_result');
    expect(test.status).toBe('success');
    expect(test.duration_ms).toBe(5300);
  });

  it('preserves order within a session even when the first event has to open it', async () => {
    const solo = new AdpRunRecorder({ client, intentId: 'intent-1', externalRef: 'issue:99', batchSize: 100 });
    await solo.start(bus);
    // Emitted back to back: the first has to wait on session creation, the rest
    // do not. Without serialized handling they would land out of order — and in
    // a hash chain, order is content.
    void bus.emit({
      type: 'session:message',
      sessionId: 's', agentName: 'Backend',
      payload: { message: 'one' },
      timestamp: new Date('2026-08-04T10:00:09Z'),
    });
    void bus.emit({
      type: 'session:message',
      sessionId: 's', agentName: 'Backend',
      payload: { message: 'two' },
      timestamp: new Date('2026-08-04T10:00:10Z'),
    });
    await bus.emit({
      type: 'session:message',
      sessionId: 's', agentName: 'Backend',
      payload: { message: 'three' },
      timestamp: new Date('2026-08-04T10:00:11Z'),
    });
    await solo.flush();

    const events = adp.eventsFor(solo.sessionsByAgent.get('Backend')!);
    expect(events.map((e) => e.payload.content ?? e.payload.role)).toBeDefined();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.occurred_at)).toEqual([
      '2026-08-04T10:00:09.000Z',
      '2026-08-04T10:00:10.000Z',
      '2026-08-04T10:00:11.000Z',
    ]);
  });

  it('retries a failed batch without appending it twice', async () => {
    adp.failAppends = 1;
    await recorder.recordCommit('Backend', 'b'.repeat(40));
    await recorder.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0].context).toMatch(/flushing 1 events/);
    // The batch is still buffered, not lost.
    expect(adp.appends).toHaveLength(0);

    await recorder.flush();
    expect(adp.appends).toHaveLength(1);

    // Re-sending the same client_event_id is a no-op at the server, which is why
    // a retry is safe rather than merely usually-harmless.
    const sessionId = recorder.sessionsByAgent.get('Backend')!;
    const clientId = adp.appends[0].events[0].client_event_id;
    const replay = await client.appendEvents(sessionId, adp.appends[0].events as never);
    expect(replay.duplicates).toEqual([clientId]);
    expect(adp.eventsFor(sessionId)).toHaveLength(1);
  });

  // An observability path that can crash the thing it observes is worse than no
  // observability path.
  it('never throws into the event bus when recording fails', async () => {
    adp.failAppends = 5;
    const busErrors: Error[] = [];
    bus.onError((error) => busErrors.push(error));

    await bus.emit({
      type: 'session:message',
      sessionId: 'squad-a',
      agentName: 'Backend',
      payload: { message: 'hello' },
      timestamp: new Date('2026-08-04T10:00:12Z'),
    });
    await recorder.settled();
    await recorder.flush();

    expect(busErrors).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('flushes before closing, because a closed run rejects later appends', async () => {
    const late = new AdpRunRecorder({ client, intentId: 'intent-1', externalRef: 'issue:7', batchSize: 100 });
    await late.start(bus);
    await late.recordCommit('Backend', 'c'.repeat(40));
    expect(adp.appends).toHaveLength(0);

    const closed = await late.close('c'.repeat(40));
    expect(closed.status).toBe('closed');
    expect(closed.final_git_sha).toBe('c'.repeat(40));
    expect(adp.appends.length).toBeGreaterThan(0);
  });

  it('reports the eval under the score gate, so candidate selection consumes it', async () => {
    await recorder.close('d'.repeat(40));
    await recorder.recordEval({ name: 'behavior', passed: true, score: 0.9, spec: { suite: 'behavior' } });

    expect(adp.evals).toHaveLength(1);
    expect(adp.evals[0].gate_name).toBe('score');
    expect(adp.evals[0].score).toBe(0.9);
  });
});
