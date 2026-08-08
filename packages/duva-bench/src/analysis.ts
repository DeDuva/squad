/**
 * Outcomes, read from ADP and from nowhere else.
 *
 * The scheduler already knows how each trial went — it watched them. This
 * deliberately ignores that and re-reads everything from the run record,
 * because the local knowledge and the attested record are exactly the two
 * things that must agree, and a report assembled from local state could never
 * discover that they had diverged. `trial.json` is pointers; this is evidence.
 *
 * **Evidence gating.** A run whose `/verify` is not `ok` gets the verdict
 * `ERROR` — never a pass, never a fail, and never a zero. It is excluded from
 * every statistic and counted out loud, because a tampered or truncated run
 * that scored 0 would drag a mean down exactly as if the agent had tried and
 * failed, which is a different claim about the world. For the same reason
 * `unscored` is not zero: a trial nobody graded is missing data.
 *
 * **Per axis, never blended.** Scores come back per axis and stay that way.
 * Averaging an `acceptance` of 1.0 with a `style` of 0.2 produces a number that
 * is not about anything, and the moment it exists someone ranks on it.
 *
 * The hallucinated-call rate is the one metric that needs the rename map: a
 * twin arm's trajectory records calls under twin names, so "did the agent
 * invent a tool" can only be answered against the surface that arm actually
 * had.
 */

import { defaultTools } from '@deduvafork/squad-lab/tools/default';
import {
  compareRuns,
  runTrajectory,
  verifyRun,
  type AdpEndpoint,
  type RunComparisonRow,
} from '@deduvafork/squad-lab/adp';
import { cells, noiseFloor, describe, type Cell, type RunObservation } from '@deduvafork/squad-lab/variance';

import { buildToolset } from './twins.js';
import { armDigest, studyDigest, shortDigest, type Arm, type Study } from './study.js';
import { planTrials } from './scheduler.js';

// ─── Shapes ──────────────────────────────────────────────────────────────

export type Verdict = 'ok' | 'ERROR' | 'missing';

export interface TrialOutcome {
  externalRef: string;
  taskId: string;
  armId: string;
  rep: number;
  runId?: string;
  status?: string;
  /** ADP's own answer. `null` means it could not be asked. */
  verified: boolean | null;
  /**
   * `ok` only when ADP verified it. Anything else is `ERROR` and is excluded
   * from statistics — never scored as zero, which would be a claim that the
   * agent tried and failed.
   */
  verdict: Verdict;
  excludedBy?: string;
  /** Per axis, never blended. `null` is unscored, which is not zero. */
  axes: Record<string, number | null>;
  /**
   * The grader's own pass/fail per axis.
   *
   * Carried separately from the score because the paired statistics are
   * binary-outcome tests — McNemar and the paired bootstrap over tasks — and
   * thresholding a score here would invent a cut-off the grader never declared.
   */
  axesPassed: Record<string, boolean | null>;
  tokensIn: number;
  tokensOut: number;
  /** `null` when the vendor publishes no rate — never rendered as $0.00. */
  costMicroUsd: number | null;
  durationMs: number;
  toolCalls: number;
  toolFailures: number;
  /** Share of tool calls that failed. `null` when nothing was called. */
  toolErrorRate: number | null;
  /** Model calls — how many turns of the loop the agent actually spent. */
  steps: number;
  /** Calls naming a tool the arm did not have. */
  hallucinatedCalls: number;
  hallucinatedCallRate: number | null;
  /** The names it invented, so a reader can see what it reached for. */
  hallucinatedNames: string[];
  labels: Record<string, string>;
  trajectoryDigest: string | null;
}

export interface Outcomes {
  studyDigest: string;
  collectedAt: string;
  trials: TrialOutcome[];
  /** Trials the plan expected that ADP has no run for. */
  missing: string[];
  exclusions: Record<string, number>;
}

// ─── The arm's actual tool surface ───────────────────────────────────────

/**
 * The tool names an arm had, standard or twinned.
 *
 * Derived from the spec rather than read from a trial's `rename-map.json`: the
 * generator is deterministic in its seed, so the surface is a property of the
 * study, and re-deriving it means an analysis works on a machine that never
 * ran the study.
 */
export function toolSurfaceOf(arm: Arm): Set<string> {
  const built = buildToolset(defaultTools('/'), {
    ...(arm.toolset.twinSeed !== undefined ? { twinSeed: arm.toolset.twinSeed } : {}),
    docsGrade: arm.toolset.docsGrade,
  });
  return new Set(built.tools.map((t) => t.name));
}

// ─── Collection ──────────────────────────────────────────────────────────

export interface CollectDeps {
  compareRuns: typeof compareRuns;
  verifyRun: typeof verifyRun;
  runTrajectory: typeof runTrajectory;
}

interface TrajectoryEvent {
  kind: string;
  type: string | null;
  status: string | null;
}

/** Tool and step counts, taken from the trajectory rather than the summary row. */
export function readTrajectory(
  events: TrajectoryEvent[],
  surface: Set<string>,
): { steps: number; toolCalls: number; toolFailures: number; hallucinated: string[] } {
  let steps = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  const hallucinated: string[] = [];

  for (const event of events) {
    if (event.kind === 'model_call') {
      steps += 1;
      continue;
    }
    if (event.kind !== 'tool_call') continue;
    toolCalls += 1;
    if (event.status === 'failure') toolFailures += 1;
    const name = event.type ?? '';
    // A name outside the arm's surface is a tool the agent invented. Judged
    // against *this arm's* names, so a twin arm is scored on the same footing
    // as its control rather than being marked wrong for using its own tools.
    if (name && !surface.has(name)) hallucinated.push(name);
  }

  return { steps, toolCalls, toolFailures, hallucinated };
}

function axesOf(row: RunComparisonRow): {
  axes: Record<string, number | null>;
  passed: Record<string, boolean | null>;
} {
  const axes: Record<string, number | null> = {};
  const passed: Record<string, boolean | null> = {};
  const evals = row.evals ?? (row.eval ? [row.eval] : []);
  for (const entry of evals) {
    axes[entry.name] = entry.score;
    // An unscored axis has no verdict either. `false` would be a claim the
    // grader did not make.
    passed[entry.name] = entry.score === null ? null : entry.passed;
  }
  return { axes, passed };
}

/**
 * Read every trial of a study back out of ADP.
 *
 * One `runs/compare` per task — the per-intent read, which is what makes these
 * runs a comparison at all — then `/verify` and the trajectory per run.
 */
export async function collectOutcomes(
  ep: AdpEndpoint,
  study: Study,
  intents: Map<string, string>,
  deps: Partial<CollectDeps> = {},
): Promise<Outcomes> {
  const d: CollectDeps = { compareRuns, verifyRun, runTrajectory, ...deps };
  const digest = studyDigest(study);
  const armsById = new Map(study.arms.map((a) => [a.id, a]));
  const planned = planTrials(study);
  const byRef = new Map(planned.map((t) => [t.externalRef, t]));

  const trials: TrialOutcome[] = [];
  const seen = new Set<string>();
  const exclusions: Record<string, number> = {};

  for (const [taskId, intentId] of intents) {
    const { runs } = await d.compareRuns(ep, intentId);

    for (const row of runs) {
      const ref = row.externalRef;
      if (!ref) continue;
      const plan = byRef.get(ref);
      // A run against this intent that the plan does not know about is not
      // this study's — two studies can share a task, and silently folding in
      // a stranger's run is how a result stops being about what it says.
      if (!plan || plan.taskId !== taskId) continue;
      seen.add(ref);

      let verified: boolean | null = null;
      try {
        const verdictBody = await d.verifyRun(ep, row.runId);
        verified = verdictBody.ok === true;
      } catch {
        verified = null;
      }

      const arm = armsById.get(plan.armId);
      const surface = arm ? toolSurfaceOf(arm) : new Set<string>();
      let traj = { steps: 0, toolCalls: row.toolCalls, toolFailures: row.toolFailures, hallucinated: [] as string[] };
      try {
        const body = (await d.runTrajectory(ep, row.runId, '?limit=1000')) as { events?: TrajectoryEvent[] };
        traj = readTrajectory(body.events ?? [], surface);
      } catch {
        // Trajectory unavailable: the summary row's counts still stand, and
        // the process metrics that need the trajectory stay absent rather than
        // being invented from the row.
      }

      const verdict: Verdict = verified === true ? 'ok' : 'ERROR';
      if (verdict === 'ERROR') exclusions['unverified-run'] = (exclusions['unverified-run'] ?? 0) + 1;

      trials.push({
        externalRef: ref,
        taskId,
        armId: plan.armId,
        rep: plan.rep,
        runId: row.runId,
        status: row.status,
        verified,
        verdict,
        ...(verdict === 'ERROR' ? { excludedBy: 'unverified-run' } : {}),
        axes: axesOf(row).axes,
        axesPassed: axesOf(row).passed,
        tokensIn: row.tokensIn,
        tokensOut: row.tokensOut,
        // Structurally zero means "no published rate", not "free" — the run
        // row carries 0 for an unpriced vendor and rendering that as a dollar
        // figure invites exactly the wrong conclusion.
        costMicroUsd: row.costMicroUsd > 0 ? row.costMicroUsd : null,
        durationMs: row.durationMs,
        toolCalls: traj.toolCalls,
        toolFailures: traj.toolFailures,
        toolErrorRate: traj.toolCalls > 0 ? traj.toolFailures / traj.toolCalls : null,
        steps: traj.steps,
        hallucinatedCalls: traj.hallucinated.length,
        hallucinatedCallRate: traj.toolCalls > 0 ? traj.hallucinated.length / traj.toolCalls : null,
        hallucinatedNames: [...new Set(traj.hallucinated)].sort(),
        labels: row.labels ?? {},
        trajectoryDigest: row.trajectoryDigest,
      });
    }
  }

  trials.sort((a, b) => a.externalRef.localeCompare(b.externalRef));
  const missing = planned.map((t) => t.externalRef).filter((ref) => !seen.has(ref));
  if (missing.length > 0) exclusions['no-run'] = missing.length;

  return { studyDigest: digest, collectedAt: new Date().toISOString(), trials, missing, exclusions };
}

// ─── Statistics ──────────────────────────────────────────────────────────

/** Only `ok` trials reach a statistic. Everything else is counted, not scored. */
export function includedTrials(outcomes: Outcomes): TrialOutcome[] {
  return outcomes.trials.filter((t) => t.verdict === 'ok');
}

/** Every axis any included trial was scored on. */
export function axesOfStudy(outcomes: Outcomes): string[] {
  const axes = new Set<string>();
  for (const trial of includedTrials(outcomes)) {
    for (const axis of Object.keys(trial.axes)) axes.add(axis);
  }
  return [...axes].sort();
}

/** Reshape for squad-lab's variance module, which is the noise floor. */
export function observationsOf(outcomes: Outcomes, study: Study): RunObservation[] {
  const armsById = new Map(study.arms.map((a) => [a.id, a]));
  return includedTrials(outcomes).map((trial) => {
    const arm = armsById.get(trial.armId);
    return {
      task: trial.taskId,
      model: trial.labels.model ?? arm?.model.model ?? arm?.model.provider ?? 'unknown',
      // The cell key: a "harness" here is the whole program the agent ran, so
      // the arm id is the honest label — two arms differing in toolset are not
      // the same harness however identical their loop.
      harness: trial.armId,
      variantId: trial.externalRef,
      axes: trial.axes,
      tokensIn: trial.tokensIn,
      tokensOut: trial.tokensOut,
      costMicroUsd: trial.costMicroUsd,
      toolCalls: trial.toolCalls,
      toolFailures: trial.toolFailures,
      durationMs: trial.durationMs,
    };
  });
}

export interface CellSummary {
  armId: string;
  taskId: string;
  n: number;
  axes: Record<string, { mean: number; sd: number | null; n: number } | null>;
  hallucinatedCallRate: { mean: number; sd: number | null; n: number } | null;
  toolErrorRate: { mean: number; sd: number | null; n: number } | null;
  steps: { mean: number; sd: number | null; n: number } | null;
}

/** Per arm × task, per axis. Never averaged across arms or across axes. */
export function summariseCells(outcomes: Outcomes, axes: string[]): CellSummary[] {
  const groups = new Map<string, TrialOutcome[]>();
  for (const trial of includedTrials(outcomes)) {
    const key = `${trial.armId} ${trial.taskId}`;
    groups.set(key, [...(groups.get(key) ?? []), trial]);
  }

  return [...groups.entries()]
    .map(([key, trials]) => {
      const [armId, taskId] = key.split(' ') as [string, string];
      const axisStats: CellSummary['axes'] = {};
      for (const axis of axes) axisStats[axis] = describe(trials.map((t) => t.axes[axis]));
      return {
        armId,
        taskId,
        n: trials.length,
        axes: axisStats,
        hallucinatedCallRate: describe(trials.map((t) => t.hallucinatedCallRate)),
        toolErrorRate: describe(trials.map((t) => t.toolErrorRate)),
        steps: describe(trials.map((t) => t.steps)),
      };
    })
    .sort((a, b) => `${a.armId}${a.taskId}`.localeCompare(`${b.armId}${b.taskId}`));
}

export interface NoiseFloor {
  axis: string;
  sd: number;
  cells: number;
}

/** Pooled within-cell spread, which every contrast is read against. */
export function noiseFloors(observations: RunObservation[], axes: string[]): NoiseFloor[] {
  const cs: Cell[] = cells(observations, axes);
  const floors: NoiseFloor[] = [];
  for (const axis of axes) {
    const floor = noiseFloor(cs, axis);
    if (floor) floors.push({ axis, sd: floor.sd, cells: floor.cells });
  }
  return floors;
}

/** The cost ledger, with unpriced trials named rather than folded into zero. */
export function costLedger(outcomes: Outcomes): {
  totalMicroUsd: number;
  pricedTrials: number;
  unpricedTrials: number;
} {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  for (const trial of outcomes.trials) {
    if (trial.costMicroUsd === null) unpriced += 1;
    else {
      total += trial.costMicroUsd;
      priced += 1;
    }
  }
  return { totalMicroUsd: total, pricedTrials: priced, unpricedTrials: unpriced };
}

export const studyShort = (outcomes: Outcomes): string => shortDigest(outcomes.studyDigest);
export { armDigest };
