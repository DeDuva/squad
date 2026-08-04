/**
 * Records a Squad assignment into ADP as a run with a durable trajectory.
 *
 * One assignment becomes one ADP run; each agent becomes an ADP session; every
 * message, model call, tool execution, and handoff Squad's EventBus emits is
 * appended to that agent's trajectory. Commits and test results are reported
 * explicitly (see `recordCommit` / `recordTestResult`) because Squad's bus does
 * not emit them — inferring a commit by pattern-matching Bash tool calls would
 * be a guess dressed as provenance.
 *
 * Two properties this module holds to, both learned the hard way in
 * observability code:
 *
 * 1. **Recording never breaks the thing it records.** Every failure is routed to
 *    `onError` and swallowed. An EventBus handler that throws would take out the
 *    orchestrator it was supposed to be watching, which is strictly worse than
 *    losing the trace.
 * 2. **Retries are safe.** Every event carries a `client_event_id`, and ADP
 *    de-duplicates on it before hash-chaining, so a batch resent after a network
 *    error produces exactly the chain the first attempt did.
 *
 * @module adp/recorder
 */

import { randomUUID } from 'node:crypto';
import type { EventBus, SquadEvent, UnsubscribeFn } from '../runtime/event-bus.js';
import type {
  AgentMilestonePayload,
  CoordinatorRoutingPayload,
  SessionMessagePayload,
  SessionToolCallPayload,
  SessionCreatedPayload,
  SessionErrorPayload,
  SessionDestroyedPayload,
} from '../runtime/event-payloads.js';
import { AdpClient, type AdpEvent, type AdpEventStatus, type AdpRun } from './client.js';

/** The name Squad reports itself under. ADP never branches on it. */
export const ORCHESTRATOR = 'squad';

/**
 * The session standing in for Squad's coordinator. Routing decisions are
 * orchestrator-level, but every ADP event belongs to exactly one session's hash
 * chain — so the coordinator gets a session of its own rather than ADP growing a
 * second, run-level append path to keep consistent.
 */
export const COORDINATOR_HARNESS = 'squad-coordinator';

export interface AdpRecorderOptions {
  client: AdpClient;
  /** The intent the assignment is against — ADP creates one per issue. */
  intentId: string;
  /** Squad's own id for the assignment; makes opening the run idempotent. */
  externalRef?: string;
  /** Harness identifier recorded for agent sessions. */
  harness?: string;
  /** Flush when this many events are buffered for one session. */
  batchSize?: number;
  /** Flush at most this many milliseconds after the first buffered event. */
  flushIntervalMs?: number;
  /** Called for every recording failure. Never throws into Squad's event loop. */
  onError?: (error: Error, context: string) => void;
  /** Injected for tests. */
  now?: () => Date;
}

interface Buffered {
  events: AdpEvent[];
  timer?: ReturnType<typeof setTimeout>;
}

function toolStatus(resultType: SessionToolCallPayload['resultType']): AdpEventStatus | undefined {
  switch (resultType) {
    case 'success':
      return 'success';
    case 'failure':
      return 'failure';
    case 'rejected':
    case 'denied':
      return 'rejected';
    default:
      return undefined;
  }
}

export class AdpRunRecorder {
  private readonly client: AdpClient;
  private readonly options: Required<Pick<AdpRecorderOptions, 'batchSize' | 'flushIntervalMs' | 'harness'>> &
    AdpRecorderOptions;
  private readonly buffers = new Map<string, Buffered>();
  /** Squad session id -> ADP session id. */
  private readonly sessionIds = new Map<string, string>();
  /** Agent name -> ADP session id, so a handoff can name its target. */
  private readonly agentSessions = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();
  /**
   * Handling is serialized on this chain.
   *
   * The bus does not await handlers, and `handle` awaits session resolution on
   * some paths and not others — so without this, an event whose session already
   * existed could be buffered ahead of an earlier event that was still waiting
   * for one to be created. That is an ordering inversion inside a hash chain,
   * where order *is* the content. Serializing costs nothing that matters:
   * everything on this path is buffering, and the one network call it makes
   * (opening a session) had to happen before the event could be recorded anyway.
   */
  private chain: Promise<void> = Promise.resolve();
  private unsubscribe?: UnsubscribeFn;
  private run?: AdpRun;
  private coordinatorSessionId?: string;

  constructor(options: AdpRecorderOptions) {
    this.client = options.client;
    this.options = {
      batchSize: 50,
      flushIntervalMs: 2000,
      harness: 'squad-agent',
      ...options,
    };
  }

  get runId(): string | undefined {
    return this.run?.id;
  }

  /** ADP session ids by agent name — useful for assertions and for debugging. */
  get sessionsByAgent(): ReadonlyMap<string, string> {
    return this.agentSessions;
  }

  private fail(error: unknown, context: string): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.options.onError?.(err, context);
  }

  /** Opens the run and subscribes to the bus. Safe to call once per assignment. */
  async start(bus: EventBus): Promise<AdpRun> {
    this.run = await this.client.openRun({
      intentId: this.options.intentId,
      orchestrator: ORCHESTRATOR,
      externalRef: this.options.externalRef,
    });
    this.coordinatorSessionId = await this.openSession(COORDINATOR_HARNESS);
    this.unsubscribe = bus.subscribeAll((event) => {
      // Returns immediately on purpose: the bus awaits its handlers, and a
      // recorder that made every agent turn wait on an HTTP round trip would be
      // a tax on the work it is meant to observe. The chain preserves order
      // without holding the emitter up.
      this.chain = this.chain.then(() =>
        this.handle(event).catch((error) => this.fail(error, `handling ${event.type}`)),
      );
    });
    return this.run;
  }

  /**
   * Resolves once every event emitted so far has been handled and buffered.
   * Recording is asynchronous by design, so anything asserting on it — a test,
   * or a caller about to read the run back — needs a point to wait for.
   */
  async settled(): Promise<void> {
    await this.chain;
  }

  private async openSession(harness: string): Promise<string> {
    if (!this.run) throw new Error('recorder not started');
    const session = await this.client.startSession({ harness, runId: this.run.id });
    return session.id;
  }

  /**
   * Resolves an agent's ADP session, creating it on first mention.
   *
   * Created on first *mention* rather than on `session:created` because the
   * coordinator routes to an agent before spawning it — and a handoff recorded
   * before its target exists would have to either lose the edge or be buffered
   * until the target appeared. Creating eagerly keeps the edge and the code
   * simple. Concurrent callers share one in-flight promise so two events for a
   * new agent do not open two sessions.
   */
  private async sessionForAgent(agentName: string): Promise<string> {
    const existing = this.agentSessions.get(agentName);
    if (existing) return existing;
    const inFlight = this.pending.get(agentName);
    if (inFlight) return inFlight;

    const promise = this.openSession(`${this.options.harness}:${agentName}`)
      .then((id) => {
        this.agentSessions.set(agentName, id);
        this.pending.delete(agentName);
        return id;
      })
      .catch((error) => {
        this.pending.delete(agentName);
        throw error;
      });
    this.pending.set(agentName, promise);
    return promise;
  }

  /** Resolves the ADP session an event belongs to, keyed by Squad's session id. */
  private async sessionFor(event: SquadEvent): Promise<string | undefined> {
    if (event.sessionId) {
      const mapped = this.sessionIds.get(event.sessionId);
      if (mapped) return mapped;
    }
    if (event.agentName) {
      const id = await this.sessionForAgent(event.agentName);
      if (event.sessionId) this.sessionIds.set(event.sessionId, id);
      return id;
    }
    return this.coordinatorSessionId;
  }

  private async handle(event: SquadEvent): Promise<void> {
    if (!this.run) return;
    const occurredAt = event.timestamp?.toISOString();

    switch (event.type) {
      case 'session:created': {
        const payload = event.payload as SessionCreatedPayload;
        const sessionId = await this.sessionForAgent(payload.agentName);
        if (event.sessionId) this.sessionIds.set(event.sessionId, sessionId);
        this.enqueue(sessionId, {
          kind: 'custom',
          type: 'session:created',
          payload: { agentName: payload.agentName, priority: payload.priority },
          occurred_at: occurredAt,
        });
        return;
      }

      case 'session:message': {
        const payload = event.payload as SessionMessagePayload;
        const sessionId = await this.sessionFor(event);
        if (!sessionId) return;
        this.enqueue(sessionId, {
          kind: 'message',
          type: payload.role ?? 'message',
          payload: { role: payload.role, content: payload.content ?? payload.message },
          occurred_at: occurredAt,
        });
        return;
      }

      case 'session:tool_call': {
        const payload = event.payload as SessionToolCallPayload;
        const sessionId = await this.sessionFor(event);
        if (!sessionId) return;
        this.enqueue(sessionId, {
          kind: 'tool_call',
          type: payload.toolName,
          payload: { args: payload.toolArgs },
          status: toolStatus(payload.resultType),
          occurred_at: occurredAt,
        });
        return;
      }

      case 'agent:milestone': {
        const payload = event.payload as AgentMilestonePayload;
        const sessionId = await this.sessionFor(event);
        if (!sessionId) return;
        // Squad's milestones are about model selection — a fallback is a model
        // call that failed and a retry under another model. Recording them as
        // `model_call` with a failure status is what makes "which models cost
        // us retries" answerable from the trajectory.
        this.enqueue(sessionId, {
          kind: 'model_call',
          type: payload.event,
          payload,
          status: payload.event === 'model.exhausted' ? 'error' : 'failure',
          model: payload.event === 'model.fallback' ? payload.failedModel : payload.originalModel,
          occurred_at: occurredAt,
        });
        return;
      }

      case 'coordinator:routing': {
        const payload = event.payload as CoordinatorRoutingPayload;
        if (!this.coordinatorSessionId) return;
        if (payload.phase === 'routed') {
          // One handoff event per target, each carrying the real edge — the
          // handoff graph is then a query in ADP rather than a payload scan.
          for (const agentName of payload.agents) {
            const target = await this.sessionForAgent(agentName);
            this.enqueue(this.coordinatorSessionId, {
              kind: 'handoff',
              type: 'coordinator:routing',
              payload: { agent: agentName, confidence: payload.confidence, reason: payload.reason },
              related_session_id: target,
              occurred_at: occurredAt,
            });
          }
          return;
        }
        this.enqueue(this.coordinatorSessionId, {
          kind: 'custom',
          type: `coordinator:${payload.phase}`,
          payload,
          occurred_at: occurredAt,
        });
        return;
      }

      case 'session:error': {
        const payload = event.payload as SessionErrorPayload;
        const sessionId = await this.sessionFor(event);
        if (!sessionId) return;
        this.enqueue(sessionId, {
          kind: 'custom',
          type: 'session:error',
          payload: { error: payload.error },
          status: 'error',
          occurred_at: occurredAt,
        });
        return;
      }

      case 'session:destroyed': {
        const payload = event.payload as SessionDestroyedPayload;
        const sessionId = await this.sessionFor(event);
        if (!sessionId) return;
        this.enqueue(sessionId, {
          kind: 'custom',
          type: 'session:destroyed',
          payload: { reason: payload.reason },
          occurred_at: occurredAt,
        });
        // Flush rather than close the ADP session: Squad may spawn the agent
        // again under the same name, and closing here would strand the events
        // that arrive next. Closing the run closes every session anyway.
        await this.flushSession(sessionId);
        return;
      }

      // pool:health is a gauge, not something that happened in a trajectory.
      // Recording it would bury the events that carry meaning under sampling
      // noise, which is how a trajectory store stops being read.
      case 'pool:health':
      case 'session:idle':
      default:
        return;
    }
  }

  /**
   * Record a commit the assignment produced. Squad's bus does not emit these,
   * and inferring them from Bash tool calls would be a guess presented as
   * provenance — so the caller reports the sha it actually pushed.
   */
  async recordCommit(agentName: string, gitSha: string, details: Record<string, unknown> = {}): Promise<void> {
    try {
      const sessionId = await this.sessionForAgent(agentName);
      this.enqueue(sessionId, {
        kind: 'commit',
        type: 'push',
        payload: details,
        git_sha: gitSha,
        status: 'success',
      });
    } catch (error) {
      this.fail(error, 'recordCommit');
    }
  }

  /** Record a test result against the trajectory. Same reasoning as `recordCommit`. */
  async recordTestResult(
    agentName: string,
    result: { suite: string; passed: boolean; durationMs?: number; gitSha?: string; details?: Record<string, unknown> },
  ): Promise<void> {
    try {
      const sessionId = await this.sessionForAgent(agentName);
      this.enqueue(sessionId, {
        kind: 'test_result',
        type: result.suite,
        payload: result.details ?? {},
        status: result.passed ? 'success' : 'failure',
        duration_ms: result.durationMs,
        git_sha: result.gitSha,
      });
    } catch (error) {
      this.fail(error, 'recordTestResult');
    }
  }

  /** Record a model call with its token and cost accounting. */
  async recordModelCall(
    agentName: string,
    call: {
      model: string;
      tokensIn?: number;
      tokensOut?: number;
      costMicroUsd?: number;
      durationMs?: number;
      status?: AdpEventStatus;
      details?: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      const sessionId = await this.sessionForAgent(agentName);
      this.enqueue(sessionId, {
        kind: 'model_call',
        type: 'completion',
        payload: call.details ?? {},
        model: call.model,
        tokens_in: call.tokensIn,
        tokens_out: call.tokensOut,
        cost_micro_usd: call.costMicroUsd,
        duration_ms: call.durationMs,
        status: call.status ?? 'success',
      });
    } catch (error) {
      this.fail(error, 'recordModelCall');
    }
  }

  private enqueue(sessionId: string, event: AdpEvent): void {
    const buffered = this.buffers.get(sessionId) ?? { events: [] };
    buffered.events.push({
      ...event,
      occurred_at: event.occurred_at ?? (this.options.now?.() ?? new Date()).toISOString(),
      // Assigned here rather than server-side: it has to survive a retry of the
      // *same* batch, which means it must be minted before the request, not by it.
      client_event_id: event.client_event_id ?? randomUUID(),
    });
    this.buffers.set(sessionId, buffered);

    if (buffered.events.length >= this.options.batchSize) {
      void this.flushSession(sessionId);
      return;
    }
    if (!buffered.timer) {
      buffered.timer = setTimeout(() => {
        void this.flushSession(sessionId);
      }, this.options.flushIntervalMs);
      // Never hold the process open for a pending flush.
      buffered.timer.unref?.();
    }
  }

  private async flushSession(sessionId: string): Promise<void> {
    const buffered = this.buffers.get(sessionId);
    if (!buffered || buffered.events.length === 0) return;
    if (buffered.timer) {
      clearTimeout(buffered.timer);
      buffered.timer = undefined;
    }
    const batch = buffered.events;
    buffered.events = [];

    try {
      await this.client.appendEvents(sessionId, batch);
    } catch (error) {
      // Put the batch back at the front so ordering survives a transient
      // failure. The client event ids make the retry a no-op if the server in
      // fact received it, which is the case a naive retry would double-append.
      buffered.events = [...batch, ...buffered.events];
      this.fail(error, `flushing ${batch.length} events for session ${sessionId}`);
    }
  }

  /** Flush every session's buffer. Awaited by `close`, and safe to call anytime. */
  async flush(): Promise<void> {
    // Drain the handler chain first, or an event emitted a moment ago would
    // still be in `handle` and miss the flush it was supposed to be part of.
    await this.settled();
    await Promise.all([...this.buffers.keys()].map((sessionId) => this.flushSession(sessionId)));
  }

  /**
   * Close the run against the commit the assignment produced.
   *
   * Flushes first, and that ordering is load-bearing: ADP's run attestation
   * names each session's chain head, and closing rejects later appends — so
   * anything still buffered at close time would be lost rather than merely late.
   */
  async close(finalGitSha: string): Promise<AdpRun> {
    if (!this.run) throw new Error('recorder not started');
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.flush();
    this.run = await this.client.closeRun(this.run.id, finalGitSha);
    return this.run;
  }

  /** Abandon a run that produced no commit. The trajectory is kept. */
  async abandon(reason: string): Promise<AdpRun> {
    if (!this.run) throw new Error('recorder not started');
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.flush();
    this.run = await this.client.abandonRun(this.run.id, reason);
    return this.run;
  }

  /**
   * Attach the assignment's eval result to the run, as gate evidence.
   *
   * Reported under the gate name `score` by default so a candidate set's
   * `best_score` selection consumes it unchanged — N attempts at one assignment,
   * winner chosen on attested evidence, no new resolver code.
   */
  async recordEval(input: {
    name: string;
    passed: boolean;
    score?: number;
    spec?: unknown;
    summary?: string;
    gateName?: string;
    metrics?: Record<string, unknown>;
  }) {
    if (!this.run) throw new Error('recorder not started');
    return this.client.recordEval(this.run.id, { gateName: 'score', ...input });
  }
}
