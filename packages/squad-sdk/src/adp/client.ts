/**
 * Minimal client for ADP's native plane (`/api/adp/...`).
 *
 * Deliberately not a generated SDK and deliberately not shared with
 * `platform/github.ts`: that adapter speaks GitHub's API through the `gh` CLI
 * and works against ADP unchanged, which is ADP's whole compatibility claim.
 * Runs, trajectories, and evals have no GitHub analogue, so they are reached
 * over ADP's own REST surface instead of being forced into a GitHub shape.
 *
 * @module adp/client
 */

/** An event kind ADP fixes, so trajectories from different harnesses compare. */
export type AdpEventKind =
  | 'message'
  | 'model_call'
  | 'tool_call'
  | 'handoff'
  | 'commit'
  | 'test_result'
  | 'custom';

export type AdpEventStatus = 'success' | 'failure' | 'error' | 'rejected' | 'skipped';

export interface AdpEvent {
  kind: AdpEventKind;
  /** The harness's own name within that kind — a tool name, a message role. */
  type?: string;
  /** Opaque to ADP: never parsed, never branched on. */
  payload?: unknown;
  status?: AdpEventStatus;
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_micro_usd?: number;
  duration_ms?: number;
  /** Set on commit events; joins the trajectory to the change record. */
  git_sha?: string;
  /** Set on handoff events: this event on session A naming B is the edge A→B. */
  related_session_id?: string;
  /** The emitter's own id. A repeat is dropped rather than appended twice. */
  client_event_id?: string;
  /**
   * The emitter's own contiguous counter for this session, from 1.
   * `client_event_id` makes a retry harmless; this is what makes a *drop*
   * detectable, since an event that never arrived has no id to deduplicate.
   * ADP rejects a batch that skips a number.
   */
  producer_seq?: number;
  occurred_at?: string;
}

export interface AdpRun {
  id: string;
  intent_id: string;
  orchestrator: string;
  external_ref: string | null;
  status: 'open' | 'closed' | 'abandoned';
  final_git_sha: string | null;
  trajectory_digest: string | null;
  envelope: unknown;
}

export interface AdpSession {
  id: string;
  harness: string;
  run_id: string | null;
  status: string;
}

export interface AdpAppendResult {
  session_id: string;
  appended: number;
  duplicates: string[];
  count: number;
  head: string;
  /** Highest producer_seq ADP durably holds; the mark a spool trims against. */
  accepted_through?: number | null;
}

export interface AdpEvalResult {
  id: string;
  run_id: string;
  name: string;
  git_sha: string;
  spec_digest: string;
  score: number | null;
  passed: boolean;
  trajectory_digest: string | null;
  gate: { id: string; name: string; status: string; git_sha: string; envelope: unknown };
}

export class AdpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * Set when ADP rejected a batch for skipping the emitter's numbering: the
     * producer_seq the session is waiting for. Carried rather than parsed out of
     * the message so a spool can replay from a number instead of a regex.
     */
    readonly expectedNextSeq?: number,
  ) {
    super(message);
    this.name = 'AdpError';
  }
}

export interface AdpClientOptions {
  /** Base URL of the ADP server, e.g. `http://localhost:3000`. */
  baseUrl: string;
  token: string;
  owner: string;
  repo: string;
  fetchImpl?: typeof fetch;
}

export class AdpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  readonly owner: string;
  readonly repo: string;

  constructor(options: AdpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.owner = options.owner;
    this.repo = options.repo;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private get repoPath(): string {
    return `/api/adp/repos/${this.owner}/${this.repo}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      let expectedNextSeq: number | undefined;
      try {
        const parsed = JSON.parse(text) as { message?: string; expected_next_seq?: number };
        message = parsed.message ?? text;
        expectedNextSeq = parsed.expected_next_seq;
      } catch {
        /* keep the raw body — a non-JSON error is still the most useful thing to show */
      }
      throw new AdpError(`${method} ${path} -> ${res.status}: ${message}`, res.status, expectedNextSeq);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  /**
   * Open a run for an assignment. Supplying `externalRef` makes this idempotent:
   * an orchestrator restarting after a crash rejoins the run it already opened
   * rather than forking the trajectory into two halves that each look complete.
   */
  openRun(input: { intentId: string; orchestrator: string; externalRef?: string }): Promise<AdpRun> {
    return this.request<AdpRun>('POST', `${this.repoPath}/runs`, {
      intent_id: input.intentId,
      orchestrator: input.orchestrator,
      external_ref: input.externalRef,
    });
  }

  startSession(input: { harness: string; runId: string }): Promise<AdpSession> {
    return this.request<AdpSession>('POST', `${this.repoPath}/sessions`, {
      harness: input.harness,
      run_id: input.runId,
    });
  }

  appendEvents(sessionId: string, events: AdpEvent[], producerId?: string): Promise<AdpAppendResult> {
    return this.request<AdpAppendResult>('POST', `${this.repoPath}/sessions/${sessionId}/events`, {
      events,
      ...(producerId ? { producer_id: producerId } : {}),
    });
  }

  /**
   * The intent ADP created for an issue. A run's `intent_id` is required —
   * scoring work whose goal was never stated gives a number nobody can
   * interpret — and the assignment's issue is where that goal already lives.
   */
  async getIssueIntentId(issueNumber: number): Promise<string | undefined> {
    const issue = await this.request<{ intent_id?: string }>(
      'GET',
      `/api/v3/repos/${this.owner}/${this.repo}/issues/${issueNumber}`,
    );
    return issue?.intent_id;
  }

  closeRun(runId: string, finalGitSha: string): Promise<AdpRun> {
    return this.request<AdpRun>('POST', `${this.repoPath}/runs/${runId}/close`, { final_git_sha: finalGitSha });
  }

  abandonRun(runId: string, reason: string): Promise<AdpRun> {
    return this.request<AdpRun>('POST', `${this.repoPath}/runs/${runId}/abandon`, { reason });
  }

  /**
   * Attach a deterministic eval to a run. It is recorded as an ordinary gate
   * result, so land policy and `gh pr checks` consume it through paths that
   * already exist; pass `gateName: 'score'` to feed candidate-set selection.
   */
  recordEval(
    runId: string,
    input: {
      name: string;
      passed: boolean;
      score?: number;
      summary?: string;
      spec?: unknown;
      specDigest?: string;
      gateName?: string;
      gitSha?: string;
      metrics?: Record<string, unknown>;
    },
  ): Promise<AdpEvalResult> {
    return this.request<AdpEvalResult>('POST', `${this.repoPath}/runs/${runId}/evals`, {
      name: input.name,
      passed: input.passed,
      score: input.score,
      summary: input.summary,
      spec: input.spec,
      spec_digest: input.specDigest,
      gate_name: input.gateName,
      git_sha: input.gitSha,
      metrics: input.metrics,
    });
  }

  getRun(runId: string): Promise<AdpRun & { sessions: unknown[]; evals: unknown[] }> {
    return this.request('GET', `${this.repoPath}/runs/${runId}`);
  }

  getTrajectory(runId: string, options: { kinds?: string; limit?: number } = {}): Promise<{ total: number; events: unknown[] }> {
    const query = new URLSearchParams();
    if (options.kinds) query.set('kinds', options.kinds);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const suffix = query.toString() ? `?${query}` : '';
    return this.request('GET', `${this.repoPath}/runs/${runId}/trajectory${suffix}`);
  }

  getStats(runId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `${this.repoPath}/runs/${runId}/stats`);
  }

  verifyRun(runId: string): Promise<{ ok: boolean; chains_ok: boolean; envelope_verified: boolean | null }> {
    return this.request('GET', `${this.repoPath}/runs/${runId}/verify`);
  }

  compareRuns(options: { intentId?: string; evalName?: string } = {}): Promise<{ runs: Record<string, unknown>[] }> {
    const query = new URLSearchParams();
    if (options.intentId) query.set('intent_id', options.intentId);
    if (options.evalName) query.set('eval', options.evalName);
    const suffix = query.toString() ? `?${query}` : '';
    return this.request('GET', `${this.repoPath}/runs/compare${suffix}`);
  }
}
