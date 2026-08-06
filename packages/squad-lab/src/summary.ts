/**
 * The exec summary, which is a join and not a computation.
 *
 * Every number comes from ADP's `/runs/compare` row, passed through untouched.
 * The lab contributes only `warnings` — the statements that say *this is not a
 * valid comparison*. That line is what keeps two data models from drifting
 * apart: if the lab also computed totals, its totals and ADP's would disagree
 * eventually, and the disagreement would surface mid-demo.
 */

import { compareRuns, type AdpEndpoint, type RunComparisonRow } from './adp.js';
import type { Experiment } from './experiments.js';

export type Warning =
  | { kind: 'spec_digest_mismatch'; axis: string; variantId: string; got: string; expected: string }
  | { kind: 'missing_axis'; axis: string; variantId: string }
  | { kind: 'cost_incomparable'; providers: string[] }
  | { kind: 'unscored'; variantId: string }
  | { kind: 'run_missing'; variantId: string };

export interface Summary {
  experimentId: string;
  intentId: string;
  axes: string[];
  primaryAxis?: string;
  graderSha256?: string;
  rows: (RunComparisonRow & { variantId?: string; provider?: string })[];
  warnings: Warning[];
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

  const rows = runs.map((row) => {
    const v = variantFor(exp, row);
    return { ...row, ...(v ? { variantId: v.id, provider: v.provider } : {}) };
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
