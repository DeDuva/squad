/**
 * Scoring, done by somebody other than whoever did the work.
 *
 * A grader is a plain file the user writes: `node <grader> <workRepo>` prints
 * JSON on stdout and exits 0. It reports **several named axes**, each of which
 * becomes its own ADP eval. They are never blended into one number — a run can
 * deliver a perfect module inside a repository whose own suite fails, and an
 * average of those two is a statement about neither.
 *
 * Three rules here are the difference between a measurement and a number that
 * looks like one:
 *
 *  - **The lab injects the grader file's digest into the spec**, not the
 *    grader. A grader cannot attest to its own contents, and without this an
 *    edit between the first variant and the third produces the same
 *    `spec_digest` — so the summary silently ranks two runs scored under two
 *    different rubrics.
 *  - **A grader that fails leaves the variant unscored, not zero.** Zero is a
 *    measurement; a crashed grader is the absence of one, and the two sort
 *    very differently.
 *  - **The grader runs with `cwd` outside the work repo and never sees a
 *    token.** It writes JSON to stdout and the lab posts it, under the eval
 *    identity. `separately_authorized` compares identities, so a score
 *    reported by the identity that opened the run is evidence of nothing.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';

import {
  AdpHttpError,
  recordEval,
  whoami,
  type AdpEndpoint,
  type RecordEvalInput,
} from './adp.js';

/** One dimension of a grade. `score: null` means "did not apply", not "zero". */
export interface AxisReport {
  score: number | null;
  passed: boolean;
  summary?: string;
  metrics?: Record<string, unknown>;
}

export interface GraderReport {
  /** Identifies the rubric. Digested — with the grader's sha — into `spec_digest`. */
  spec: Record<string, unknown>;
  axes: Record<string, AxisReport>;
}

export type GraderRun =
  | { ok: true; report: GraderReport; stdout: string; durationMs: number }
  | {
      ok: false;
      reason: string;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      durationMs: number;
    };

/** Ceiling on a grader. It runs a test suite, not a model. */
export const DEFAULT_GRADER_TIMEOUT_MS = 180_000;

/**
 * Deterministic JSON, byte-identical to ADP's `core/canonical.ts`.
 *
 * It has to be: the lab computes the digest it expects and ADP computes the one
 * it stores, and a disagreement between the two is reported rather than
 * papered over. Keys sort at every depth, arrays keep their order because in an
 * array order is content, and an explicit `undefined` is absent rather than
 * null — matching `JSON.stringify`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const maybeJson = value as { toJSON?: () => unknown };
  if (typeof maybeJson.toJSON === 'function') return sortKeys(maybeJson.toJSON());
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) continue;
    out[key] = sortKeys(entry);
  }
  return out;
}

/**
 * The spec every axis of every variant in one experiment shares.
 *
 * `graderSha256` is the lab's, always — a grader that names its own digest is
 * quoting a number it cannot know, so the lab's value wins rather than being
 * merged with it.
 */
export function evalSpec(spec: Record<string, unknown>, graderSha256: string): Record<string, unknown> {
  return { ...spec, graderSha256 };
}

/** What ADP will derive from the same spec. Computed here so a mismatch is loud. */
export function specDigestOf(spec: unknown): string {
  return createHash('sha256').update(canonicalJson(spec), 'utf8').digest('hex');
}

export class GraderContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraderContractError';
  }
}

/**
 * Read the grader's stdout as a report, or say precisely why it is not one.
 *
 * Strict on purpose. A grader whose output half-parses produces axes that look
 * like scores, and "the shape was wrong" is a fixable message where "the score
 * was undefined" is a mystery three steps downstream.
 */
export function parseGraderReport(stdout: string): GraderReport {
  const text = stdout.trim();
  if (!text) throw new GraderContractError('grader wrote nothing to stdout');

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new GraderContractError(`grader stdout is not JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GraderContractError('grader output must be a JSON object');
  }

  const { spec, axes } = raw as { spec?: unknown; axes?: unknown };
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new GraderContractError('grader output needs a `spec` object — it is what identifies the rubric');
  }
  if (typeof axes !== 'object' || axes === null || Array.isArray(axes)) {
    throw new GraderContractError('grader output needs an `axes` object');
  }
  const names = Object.keys(axes as Record<string, unknown>);
  if (names.length === 0) throw new GraderContractError('grader reported no axes');

  const parsed: Record<string, AxisReport> = {};
  for (const name of names) {
    const axis = (axes as Record<string, unknown>)[name];
    if (typeof axis !== 'object' || axis === null || Array.isArray(axis)) {
      throw new GraderContractError(`axis '${name}' must be an object`);
    }
    const { score, passed, summary, metrics } = axis as Record<string, unknown>;
    if (typeof passed !== 'boolean') {
      throw new GraderContractError(`axis '${name}' must report a boolean \`passed\``);
    }
    if (score !== null && score !== undefined) {
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        throw new GraderContractError(`axis '${name}' score must be a finite number or null`);
      }
      if (score < 0 || score > 1) {
        throw new GraderContractError(`axis '${name}' score ${score} is outside [0,1]`);
      }
    }
    parsed[name] = {
      score: typeof score === 'number' ? score : null,
      passed,
      ...(typeof summary === 'string' ? { summary } : {}),
      ...(typeof metrics === 'object' && metrics !== null && !Array.isArray(metrics)
        ? { metrics: metrics as Record<string, unknown> }
        : {}),
    };
  }
  return { spec: spec as Record<string, unknown>, axes: parsed };
}

export interface RunGraderInput {
  graderPath: string;
  /** The variant's work repository. Passed as an argument, never as cwd. */
  workRepo: string;
  /** Where the grader runs. Defaults to a fresh temp dir. Never inside `workRepo`. */
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Invoke the grader.
 *
 * The `cwd` rule is the one with teeth: a grader that runs inside the work repo
 * is a file the agents could have found, read, and written code against. It is
 * only a hidden acceptance suite for as long as it stays outside the tree they
 * were given.
 */
export async function runGrader(input: RunGraderInput): Promise<GraderRun> {
  const graderPath = resolve(input.graderPath);
  const workRepo = resolve(input.workRepo);
  if (!existsSync(graderPath)) throw new Error(`grader not found: ${graderPath}`);

  const cwd = input.cwd ? resolve(input.cwd) : mkdtempSync(join(tmpdir(), 'squad-lab-grade-'));
  mkdirSync(cwd, { recursive: true });
  const inside = relative(workRepo, cwd);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    throw new Error(
      `grader cwd ${cwd} is inside the work repo — the suite has to stay hidden from the agents`,
    );
  }

  const startedAt = Date.now();
  return await new Promise<GraderRun>((resolvePromise) => {
    execFile(
      process.execPath,
      [graderPath, workRepo],
      {
        cwd,
        timeout: input.timeoutMs ?? DEFAULT_GRADER_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        // The grader is a measurement instrument, not a participant: it gets no
        // ADP token, so it cannot report anything on its own behalf.
        env: stripTokens(process.env),
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        const exitCode = (err as { code?: number | null } | null)?.code ?? null;
        if (err) {
          resolvePromise({
            ok: false,
            reason: `grader exited non-zero: ${err.message.split('\n')[0]}`,
            stdout,
            stderr,
            exitCode: typeof exitCode === 'number' ? exitCode : null,
            durationMs,
          });
          return;
        }
        try {
          resolvePromise({ ok: true, report: parseGraderReport(stdout), stdout, durationMs });
        } catch (parseErr) {
          resolvePromise({
            ok: false,
            reason: (parseErr as Error).message,
            stdout,
            stderr,
            exitCode: 0,
            durationMs,
          });
        }
      },
    );
  });
}

/** Every ADP token this process holds, kept away from the grader child. */
function stripTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^SQUAD_LAB_.*TOKEN$/.test(key) || /^ADP_.*TOKEN$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export class SameIdentityError extends Error {
  constructor(readonly login: string) {
    super(
      `the runner and eval tokens both authenticate as '${login}' — ` +
        'evals reported under the identity that opened the run are self-reports, not evidence',
    );
    this.name = 'SameIdentityError';
  }
}

/**
 * Prove the two tokens are two principals, before anything is spent.
 *
 * `core/evals.ts` computes `separatelyAuthorized` by comparing the reporter's
 * identity to the run's, so two tokens on one identity produce evals that look
 * exactly like independent scores and are not. That misconfiguration is worse
 * than not scoring at all, which is why it stops the launch rather than warning.
 */
export async function assertSeparateIdentities(
  runner: AdpEndpoint,
  grader: AdpEndpoint,
): Promise<{ runner: string; grader: string }> {
  const [runnerWho, graderWho] = await Promise.all([whoami(runner), whoami(grader)]);
  if (runnerWho.login === graderWho.login) throw new SameIdentityError(runnerWho.login);
  return { runner: runnerWho.login, grader: graderWho.login };
}

export interface AxisEvalResult {
  axis: string;
  gateName: string;
  posted: boolean;
  score: number | null;
  passed: boolean;
  evalId?: string;
  specDigest?: string;
  separatelyAuthorized?: boolean;
  error?: string;
}

export interface GradeReportResult {
  specDigest: string;
  axes: AxisEvalResult[];
  warnings: string[];
}

export interface ReportGradeInput {
  report: GraderReport;
  graderSha256: string;
  /** The one axis reported under the literal gate name `score`. */
  primaryAxis?: string;
  /** Overrides the run's own `final_git_sha`, which is the default subject. */
  gitSha?: string | null;
}

/**
 * One `POST /runs/{runId}/evals` per axis, under the eval identity.
 *
 * `name` identifies the axis and `spec_digest` identifies the rubric, so every
 * axis of every variant in one experiment carries the same digest — that shared
 * digest is what makes two scores a ranking rather than two unrelated numbers.
 *
 * Exactly one axis reports under `gate_name: 'score'`. That keeps a candidate
 * set's `best_score` policy consumable with no new resolver code; two axes
 * under one gate name would make latest-wins resolution depend on which POST
 * landed second.
 */
export async function reportGrade(
  ep: AdpEndpoint,
  runId: string,
  input: ReportGradeInput,
): Promise<GradeReportResult> {
  const spec = evalSpec(input.report.spec, input.graderSha256);
  const expectedDigest = specDigestOf(spec);
  const warnings: string[] = [];

  // Sorted so the posting order is a property of the report rather than of
  // whatever order the grader's object literal happened to have.
  const names = Object.keys(input.report.axes).sort();
  if (input.primaryAxis && !names.includes(input.primaryAxis)) {
    warnings.push(
      `primary axis '${input.primaryAxis}' is not one of ${names.join(', ')} — no axis reports under gate 'score'`,
    );
  }

  const axes: AxisEvalResult[] = [];
  for (const axis of names) {
    const report = input.report.axes[axis]!;
    const gateName = axis === input.primaryAxis ? 'score' : `eval:${axis}`;
    const body: RecordEvalInput = {
      name: axis,
      passed: report.passed,
      // Omitted rather than sent as 0: an axis that did not apply is unscored,
      // and ADP stores the absence faithfully.
      ...(report.score === null ? {} : { score: report.score }),
      ...(report.summary ? { summary: report.summary } : {}),
      spec,
      ...(axis === input.primaryAxis ? { gate_name: 'score' } : {}),
      ...(input.gitSha ? { git_sha: input.gitSha } : {}),
      ...(report.metrics ? { metrics: report.metrics } : {}),
    };

    try {
      const posted = (await recordEval(ep, runId, body)) as {
        id?: string;
        spec_digest?: string;
        separately_authorized?: boolean;
      };
      axes.push({
        axis,
        gateName,
        posted: true,
        score: report.score,
        passed: report.passed,
        ...(posted.id ? { evalId: posted.id } : {}),
        ...(posted.spec_digest ? { specDigest: posted.spec_digest } : {}),
        ...(typeof posted.separately_authorized === 'boolean'
          ? { separatelyAuthorized: posted.separately_authorized }
          : {}),
      });
      if (posted.spec_digest && posted.spec_digest !== expectedDigest) {
        warnings.push(
          `axis '${axis}': ADP stored spec_digest ${posted.spec_digest.slice(0, 12)} where the lab computed ` +
            `${expectedDigest.slice(0, 12)} — the two are not canonicalizing the same spec`,
        );
      }
      if (posted.separately_authorized === false) {
        warnings.push(
          `axis '${axis}': ADP reports separately_authorized=false — this score is a self-report`,
        );
      }
    } catch (err) {
      // A run that never pushed has no final sha, and ADP 422s rather than
      // scoring nothing in particular. That is an unscored variant, not a
      // crashed experiment.
      const message = err instanceof AdpHttpError ? err.message : (err as Error).message;
      axes.push({ axis, gateName, posted: false, score: report.score, passed: report.passed, error: message });
    }
  }

  return { specDigest: expectedDigest, axes, warnings };
}

export interface GradeRecord {
  gradedAt: string;
  runId: string | null;
  grader: { path: string; sha256: string };
  outcome: 'scored' | 'unscored';
  reason?: string;
  specDigest?: string;
  primaryAxis?: string;
  durationMs?: number;
  report?: GraderReport;
  axes?: AxisEvalResult[];
  warnings?: string[];
}

export interface GradeVariantInput {
  graderPath: string;
  graderSha256: string;
  primaryAxis?: string;
  /** The variant's work repository, as the grader's single argument. */
  workRepo: string;
  runId: string | null;
  /** Written here as `grade.json`, the grader's raw output kept verbatim. */
  outDir: string;
  gitSha?: string | null;
  timeoutMs?: number;
  /** Absent when a variant produced no run to score. */
  evalEndpoint?: AdpEndpoint;
}

/**
 * Grade one variant end to end: invoke, record the raw output, report the axes.
 *
 * `grade.json` is written whatever happens, including for a grader that
 * crashed. An experiment where one variant is unscored has to be able to say
 * *why* — a blank cell and a zero are the same pixel otherwise.
 */
export async function gradeVariant(input: GradeVariantInput): Promise<GradeRecord> {
  const base = {
    gradedAt: new Date().toISOString(),
    runId: input.runId,
    grader: { path: input.graderPath, sha256: input.graderSha256 },
  };
  const write = (record: GradeRecord): GradeRecord => {
    mkdirSync(input.outDir, { recursive: true });
    writeFileSync(join(input.outDir, 'grade.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return record;
  };

  const run = await runGrader({
    graderPath: input.graderPath,
    workRepo: input.workRepo,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  if (!run.ok) {
    return write({ ...base, outcome: 'unscored', reason: run.reason, durationMs: run.durationMs });
  }

  if (!input.runId || !input.evalEndpoint) {
    return write({
      ...base,
      outcome: 'unscored',
      reason: input.runId ? 'no eval identity configured' : 'variant produced no run to score',
      durationMs: run.durationMs,
      report: run.report,
    });
  }

  const posted = await reportGrade(input.evalEndpoint, input.runId, {
    report: run.report,
    graderSha256: input.graderSha256,
    ...(input.primaryAxis ? { primaryAxis: input.primaryAxis } : {}),
    ...(input.gitSha ? { gitSha: input.gitSha } : {}),
  });

  return write({
    ...base,
    outcome: posted.axes.some((a) => a.posted) ? 'scored' : 'unscored',
    ...(posted.axes.every((a) => !a.posted)
      ? { reason: posted.axes[0]?.error ?? 'no axis could be reported' }
      : {}),
    specDigest: posted.specDigest,
    ...(input.primaryAxis ? { primaryAxis: input.primaryAxis } : {}),
    durationMs: run.durationMs,
    report: run.report,
    axes: posted.axes,
    ...(posted.warnings.length > 0 ? { warnings: posted.warnings } : {}),
  });
}
