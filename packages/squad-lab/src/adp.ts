/**
 * The ADP calls squad-lab makes itself.
 *
 * Recording is the SDK's job (`AdpRunRecorder`); this covers the two things
 * around it: setting a goal up, and reading results back.
 *
 * Setup runs on the **compat** plane deliberately. Nothing under `/api/adp`
 * mints an intent or creates a repository — an intent appears as a side effect
 * of filing an issue — and the brief has to live somewhere a variant can read
 * it. Filing an issue gives us both in one call, and keeps the rule that a
 * variant reads its task from the issue the intent was minted from rather than
 * from a copy someone hardcoded.
 */

export interface AdpEndpoint {
  baseUrl: string;
  token: string;
  owner: string;
  repo: string;
  fetchImpl?: typeof fetch;
}

export class AdpHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`ADP ${method} ${path} -> ${status}: ${body.slice(0, 400)}`);
    this.name = 'AdpHttpError';
  }
}

async function call<T>(
  ep: AdpEndpoint,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const doFetch = ep.fetchImpl ?? fetch;
  const res = await doFetch(`${ep.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ep.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new AdpHttpError(res.status, method, path, text);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** The principal a token authenticates as. Used to prove two tokens differ. */
export async function whoami(ep: AdpEndpoint): Promise<{ login: string }> {
  return call(ep, 'GET', '/api/v3/user');
}

/** Create the repo if it is not already there. Existing is not an error. */
export async function ensureRepo(ep: AdpEndpoint): Promise<void> {
  try {
    await call(ep, 'POST', '/api/v3/user/repos', { name: ep.repo });
  } catch (err) {
    // 422 is "already exists", which is the normal case on a re-run.
    if (err instanceof AdpHttpError && err.status === 422) return;
    throw err;
  }
}

export interface Goal {
  issueNumber: number;
  intentId: string;
  title: string;
  body: string;
}

/**
 * File the goal as an issue, which is what mints the intent every variant's run
 * hangs off.
 */
export async function createGoal(ep: AdpEndpoint, title: string, body: string): Promise<Goal> {
  const issue = await call<{ number: number; intent_id?: string; title: string; body: string }>(
    ep,
    'POST',
    `/api/v3/repos/${ep.owner}/${ep.repo}/issues`,
    { title, body },
  );
  if (!issue.intent_id) {
    throw new Error(
      `ADP filed issue #${issue.number} without an intent_id; a run cannot be opened against it`,
    );
  }
  return { issueNumber: issue.number, intentId: issue.intent_id, title: issue.title, body: issue.body };
}

/** Read a goal back. A variant does this rather than being handed the text. */
export async function readGoal(ep: AdpEndpoint, issueNumber: number): Promise<{ title: string; body: string }> {
  return call(ep, 'GET', `/api/v3/repos/${ep.owner}/${ep.repo}/issues/${issueNumber}`);
}

// --- Native plane reads -----------------------------------------------------

const nativeBase = (ep: AdpEndpoint) => `/api/adp/repos/${ep.owner}/${ep.repo}`;

export interface RunComparisonRow {
  runId: string;
  externalRef: string | null;
  orchestrator: string;
  status: string;
  finalGitSha: string | null;
  trajectoryDigest: string | null;
  eval: { name: string; score: number | null; passed: boolean; specDigest: string; gateStatus: string } | null;
  /** Present once ADP carries all named evals per run; absent on older servers. */
  evals?: { name: string; score: number | null; passed: boolean; specDigest: string; gateStatus: string }[];
  /** Present once ADP carries run labels; absent on older servers. */
  labels?: Record<string, string>;
  events: number;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  durationMs: number;
  toolCalls: number;
  toolFailures: number;
  createdAt: string;
  closedAt: string | null;
}

/** The exec summary, already ranked and aggregated server-side. */
export async function compareRuns(
  ep: AdpEndpoint,
  intentId: string,
): Promise<{ intent_id: string; runs: RunComparisonRow[] }> {
  return call(ep, 'GET', `${nativeBase(ep)}/runs/compare?intent_id=${encodeURIComponent(intentId)}`);
}

export async function getRun(ep: AdpEndpoint, runId: string): Promise<Record<string, unknown>> {
  return call(ep, 'GET', `${nativeBase(ep)}/runs/${runId}`);
}

export async function runStats(ep: AdpEndpoint, runId: string): Promise<Record<string, unknown>> {
  return call(ep, 'GET', `${nativeBase(ep)}/runs/${runId}/stats`);
}

export async function verifyRun(ep: AdpEndpoint, runId: string): Promise<Record<string, unknown>> {
  return call(ep, 'GET', `${nativeBase(ep)}/runs/${runId}/verify`);
}

export async function listEvals(
  ep: AdpEndpoint,
  runId: string,
): Promise<{ run_id: string; evals: Record<string, unknown>[] }> {
  return call(ep, 'GET', `${nativeBase(ep)}/runs/${runId}/evals`);
}

export interface RecordEvalInput {
  name: string;
  passed: boolean;
  score?: number;
  summary?: string;
  spec: Record<string, unknown>;
  gate_name?: string;
  git_sha?: string;
  metrics?: Record<string, unknown>;
}

/**
 * Report one axis. Called with the *grader's* token, never the runner's:
 * `separately_authorized` compares identities, so a self-reported score is
 * evidence of nothing.
 */
export async function recordEval(
  ep: AdpEndpoint,
  runId: string,
  input: RecordEvalInput,
): Promise<Record<string, unknown>> {
  return call(ep, 'POST', `${nativeBase(ep)}/runs/${runId}/evals`, input);
}
