/**
 * The exec summary, which is a join and not a computation.
 *
 * Every number comes from ADP's `/runs/compare` row, passed through untouched.
 * The lab contributes only `warnings` — the statements that say *this is not a
 * valid comparison*. That line is what keeps two data models from drifting
 * apart: if the lab also computed totals, its totals and ADP's would disagree
 * eventually, and the disagreement would surface mid-demo.
 */

import { compareRuns, runStats, type AdpEndpoint, type RunComparisonRow } from './adp.js';
import { classifyTools, type ToolBreakdown, type ToolStat } from './tools/taxonomy.js';
import { defaultTools } from './tools/default.js';
import type { Experiment } from './experiments.js';

export type Warning =
  | { kind: 'spec_digest_mismatch'; axis: string; variantId: string; got: string; expected: string }
  | { kind: 'missing_axis'; axis: string; variantId: string }
  | { kind: 'cost_incomparable'; providers: string[] }
  | { kind: 'unscored'; variantId: string }
  | { kind: 'run_missing'; variantId: string }
  | { kind: 'tools_not_like_for_like'; variantIds: string[] }
  | { kind: 'harness_mismatch'; harnesses: { harness: string; impl?: string; variantIds: string[] }[] };

export interface Summary {
  experimentId: string;
  intentId: string;
  axes: string[];
  primaryAxis?: string;
  graderSha256?: string;
  rows: SummaryRow[];
  warnings: Warning[];
}

export interface SummaryRow extends RunComparisonRow {
  variantId?: string;
  provider?: string;
  /**
   * Registered versus backend-supplied tool use.
   *
   * `toolCalls` on the ADP row is every tool the run invoked, which is not
   * comparable across vendors because one backend ships file tools of its own
   * and the other does not. This splits it so the headline can count the set
   * both vendors actually shared.
   */
  tools?: ToolBreakdown;
}

/**
 * Vendors whose published rates are absent by design.
 *
 * Gemini's version-free aliases carry no rate — a number pinned to a moving
 * alias is wrong the moment it moves — so `cost_micro_usd` is structurally
 * zero rather than cheap. Rendering that as a dollar figure invites exactly
 * the wrong conclusion, so a summary spanning a priced and an unpriced vendor
 * says so out loud.
 */
export const UNPRICED_PROVIDERS = new Set(['gemini']);

/**
 * Which tools the experiment registered.
 *
 * Records written before the field existed fall back to the default set, which
 * is what they would have used. Defaulting to *nothing* would be worse than a
 * guess: every tool would classify as backend-supplied, and the summary would
 * report a like-for-like disparity that never happened.
 */
function registeredToolsOf(exp: Experiment): string[] {
  return exp.registeredTools ?? defaultTools('/').map((t) => t.name);
}

/** Map a run back to the variant that produced it, by its external ref. */
function variantFor(exp: Experiment, row: RunComparisonRow): { id: string; provider: string } | undefined {
  const plan = exp.variants.find((v) => v.externalRef === row.externalRef);
  if (plan) return { id: plan.id, provider: plan.provider };
  // Labels are the durable answer once ADP carries them; the ref is the
  // fallback for a server that does not yet.
  const provider = row.labels?.['provider'];
  const variantId = row.labels?.['variant'];
  if (variantId) return { id: variantId, provider: provider ?? 'unknown' };
  return undefined;
}

export async function buildSummary(exp: Experiment, ep: AdpEndpoint): Promise<Summary> {
  const { runs } = await compareRuns(ep, exp.adp.intentId);
  const warnings: Warning[] = [];

  // `/runs/compare` gives one tool total per run and no names, so the
  // registered/built-in split needs the per-run stats. One extra request per
  // variant, and an experiment is a handful of variants — the alternative is a
  // headline number that silently means different things per vendor.
  const breakdowns = await Promise.all(
    runs.map(async (row) => {
      try {
        const stats = (await runStats(ep, row.runId)) as { tools?: ToolStat[] };
        return classifyTools(stats.tools ?? [], registeredToolsOf(exp));
      } catch {
        // Stats are an enrichment; losing them must not lose the summary.
        return undefined;
      }
    }),
  );

  const rows: SummaryRow[] = runs.map((row, i) => {
    const v = variantFor(exp, row);
    return {
      ...row,
      ...(v ? { variantId: v.id, provider: v.provider } : {}),
      ...(breakdowns[i] ? { tools: breakdowns[i] } : {}),
    };
  });

  for (const plan of exp.variants) {
    if (!rows.some((r) => r.variantId === plan.id)) {
      warnings.push({ kind: 'run_missing', variantId: plan.id });
    }
  }

  // Every axis anyone reported, so a variant missing one is visible as a gap
  // rather than as an absence nobody notices.
  const axes = [...new Set(rows.flatMap((r) => (r.evals ?? (r.eval ? [r.eval] : [])).map((e) => e.name)))].sort();

  for (const row of rows) {
    const evals = row.evals ?? (row.eval ? [row.eval] : []);
    if (evals.length === 0) {
      warnings.push({ kind: 'unscored', variantId: row.variantId ?? row.runId });
      continue;
    }
    for (const axis of axes) {
      const hit = evals.find((e) => e.name === axis);
      if (!hit) {
        warnings.push({ kind: 'missing_axis', axis, variantId: row.variantId ?? row.runId });
        continue;
      }
      // One rubric per experiment. Two variants scored under different digests
      // are two measurements, not a ranking — which is the failure a blended
      // number hides most effectively.
      const expected = rows
        .map((r) => (r.evals ?? (r.eval ? [r.eval] : [])).find((e) => e.name === axis)?.specDigest)
        .find((d): d is string => Boolean(d));
      if (expected && hit.specDigest !== expected) {
        warnings.push({
          kind: 'spec_digest_mismatch',
          axis,
          variantId: row.variantId ?? row.runId,
          got: hit.specDigest,
          expected,
        });
      }
    }
  }

  const providers = [...new Set(rows.map((r) => r.provider).filter((p): p is string => Boolean(p)))];
  const unpriced = providers.filter((p) => UNPRICED_PROVIDERS.has(p));
  if (unpriced.length > 0 && unpriced.length < providers.length) {
    warnings.push({ kind: 'cost_incomparable', providers: unpriced });
  }

  // A backend that brings its own tools makes the raw call count mean
  // something different on that side. Only worth saying when the set is mixed:
  // if every variant has built-ins, or none does, the totals still line up.
  const withBuiltins = rows.filter((r) => r.tools?.hasBuiltins);
  if (withBuiltins.length > 0 && withBuiltins.length < rows.length) {
    warnings.push({
      kind: 'tools_not_like_for_like',
      variantIds: withBuiltins.map((r) => r.variantId ?? r.runId),
    });
  }

  // Runs driven by different agent loops, in one table.
  //
  // Deliberate — one model under both arms is the comparison the lab exists
  // for — but the rows are then not like-for-like, and a single ranking across
  // them would read as a statement about the models. The digest is the
  // attested one from the run's own labels, so this is a fact about what ADP
  // holds rather than about what the lab meant to do.
  const byHarness = new Map<string, { impl?: string; variantIds: string[] }>();
  for (const row of rows) {
    const harness = row.labels?.['harness'];
    if (!harness) continue;
    const band = byHarness.get(harness) ?? {
      ...(row.labels?.['harness_impl'] ? { impl: row.labels['harness_impl'] } : {}),
      variantIds: [],
    };
    band.variantIds.push(row.variantId ?? row.runId);
    byHarness.set(harness, band);
  }
  if (byHarness.size > 1) {
    warnings.push({
      kind: 'harness_mismatch',
      harnesses: [...byHarness].map(([harness, band]) => ({ harness, ...band })),
    });
  }

  return {
    experimentId: exp.id,
    intentId: exp.adp.intentId,
    axes,
    ...(exp.grader?.primaryAxis ? { primaryAxis: exp.grader.primaryAxis } : {}),
    ...(exp.grader?.sha256 ? { graderSha256: exp.grader.sha256 } : {}),
    rows,
    warnings,
  };
}

/**
 * Rank one axis on its own.
 *
 * Never blended with any other axis, and unscored sorts last rather than as
 * zero — an unmeasured variant is unmeasured, and sorting it as if it scored
 * nothing invents evidence. Ties share a rank.
 */
export function rankByAxis(summary: Summary, axis: string): { variantId: string; score: number | null; rank: number | null }[] {
  const entries = summary.rows.map((r) => {
    const hit = (r.evals ?? (r.eval ? [r.eval] : [])).find((e) => e.name === axis);
    return { variantId: r.variantId ?? r.runId, score: hit?.score ?? null };
  });
  const scored = entries.filter((e) => e.score !== null).sort((a, b) => b.score! - a.score!);

  let rank = 0;
  let lastScore: number | null = null;
  const ranks = new Map<string, number>();
  scored.forEach((e, i) => {
    if (e.score !== lastScore) {
      rank = i + 1;
      lastScore = e.score;
    }
    ranks.set(e.variantId, rank);
  });

  return entries.map((e) => ({ ...e, rank: ranks.get(e.variantId) ?? null }));
}
