/**
 * The rules the exec summary refuses to break, kept out of the components.
 *
 * These are here as plain functions because they are the product, not the
 * presentation: a table that blends two axes into one number, or renders an
 * unmeasured variant as `0.00`, is wrong in a way no amount of styling fixes.
 * Rendering them in JSX would leave them untestable and, worse, easy to
 * "simplify" later by someone reading only the component.
 *
 * Five of them, each the difference between a comparison and a number that
 * looks like one:
 *
 *  1. **Rank per column, computed independently.** `#1` on `acceptance` says
 *     nothing about `self-tests`. There is no mean, no weighting, and the word
 *     "overall" does not appear.
 *  2. **A disagreement between axes is a first-class state**, not a footnote.
 *     It is the reason the product exists — two vendors tied on a module while
 *     one of them shipped a repo whose own suite fails — so burying it would
 *     be the product failing.
 *  3. **One rubric per column.** Variants scored under different `spec_digest`
 *     values are two measurements; the column is greyed and its ranks
 *     suppressed rather than ordered.
 *  4. **Unscored is not zero.** It reads "not measured", sorts last, and never
 *     renders as `0.00`.
 *  5. **Unpriced is not free.** A vendor with no published rate renders
 *     `unpriced`, never `$0.00`, and cost is never sortable.
 */

export interface EvalView {
  name: string;
  score: number | null;
  passed: boolean;
  specDigest: string;
}

export interface SummaryRowView {
  runId: string;
  variantId?: string;
  provider?: string;
  labels?: Record<string, string>;
  eval: EvalView | null;
  evals?: EvalView[];
  events: number;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  durationMs: number;
  toolCalls: number;
  toolFailures: number;
  tools?: {
    registered: { name: string; count: number; failures: number }[];
    builtin: { name: string; count: number; failures: number }[];
    registeredCalls: number;
    registeredFailures: number;
    builtinCalls: number;
    hasBuiltins: boolean;
  };
}

export interface SummaryView {
  experimentId: string;
  intentId: string;
  axes: string[];
  primaryAxis?: string;
  graderSha256?: string;
  rows: SummaryRowView[];
  warnings: { kind: string; [k: string]: unknown }[];
}

export const UNPRICED_PROVIDERS = new Set(['gemini']);

const evalsOf = (row: SummaryRowView): EvalView[] => row.evals ?? (row.eval ? [row.eval] : []);

export interface AxisCell {
  variantId: string;
  runId: string;
  score: number | null;
  /** Null when unscored, or when the column is not a ranking at all. */
  rank: number | null;
  passed: boolean;
  display: string;
  /** The attested harness digest, when the run carried one. */
  harness?: string;
  harnessImpl?: string;
}

export interface AxisColumn {
  axis: string;
  /** Shown in the header. Absent only when no variant reported this axis. */
  specDigest?: string;
  /** True when variants disagree on the rubric; ranks are suppressed. */
  mismatched: boolean;
  /**
   * True when the column spans more than one harness.
   *
   * Ranks are then computed **within** each harness rather than across the
   * column: two loops driving the same model is a comparison of the loops, and
   * a single ordering over both would be read as a comparison of the models.
   */
  banded: boolean;
  note?: string;
  cells: AxisCell[];
}

const harnessOf = (row: SummaryRowView): string => row.labels?.['harness'] ?? '';

/** `— not measured`, never `0.00`: the two mean opposite things. */
export function formatScore(score: number | null): string {
  return score === null ? '— not measured' : score.toFixed(2);
}

/**
 * One column, ranked on its own.
 *
 * Ties share a rank. Unscored rows carry no rank at all rather than a last
 * place, because ordering something that was never measured invents evidence
 * about it.
 */
export function axisColumn(summary: SummaryView, axis: string): AxisColumn {
  const found = summary.rows
    .map((row) => ({ row, hit: evalsOf(row).find((e) => e.name === axis) }))
    .filter((x) => x.hit);

  const digests = [...new Set(found.map((x) => x.hit!.specDigest))];
  const mismatched = digests.length > 1;

  const banded = new Set(found.map((x) => harnessOf(x.row))).size > 1;

  const scored = found
    .filter((x) => x.hit!.score !== null)
    .sort((a, b) => b.hit!.score! - a.hit!.score!);

  // One ranking per harness when the column is banded, one overall when it is
  // not. Same tie rules either way: equal scores share a position.
  const ranks = new Map<string, number>();
  const groups = banded
    ? [...new Set(scored.map((x) => harnessOf(x.row)))].map((h) =>
        scored.filter((x) => harnessOf(x.row) === h),
      )
    : [scored];
  for (const group of groups) {
    let rank = 0;
    let last: number | null = null;
    group.forEach((x, i) => {
      if (x.hit!.score !== last) {
        rank = i + 1;
        last = x.hit!.score;
      }
      ranks.set(x.row.runId, rank);
    });
  }

  const cells: AxisCell[] = summary.rows.map((row) => {
    const hit = evalsOf(row).find((e) => e.name === axis);
    const score = hit?.score ?? null;
    return {
      variantId: row.variantId ?? row.runId,
      runId: row.runId,
      score,
      // A column scored under two rubrics is not a ranking, so it shows no
      // positions at all rather than positions nobody should read.
      rank: mismatched ? null : (ranks.get(row.runId) ?? null),
      passed: hit?.passed ?? false,
      display: formatScore(score),
      ...(row.labels?.['harness'] ? { harness: row.labels['harness'] } : {}),
      ...(row.labels?.['harness_impl'] ? { harnessImpl: row.labels['harness_impl'] } : {}),
    };
  });

  // Unscored last, and only among themselves by variant id — a stable order
  // that says nothing about quality.
  cells.sort((a, b) => {
    if (a.score === null && b.score === null) return a.variantId.localeCompare(b.variantId);
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  });

  return {
    axis,
    ...(digests[0] ? { specDigest: digests[0] } : {}),
    mismatched,
    banded,
    ...(mismatched
      ? { note: 'scored under different rubrics — not a ranking' }
      : banded
        ? { note: 'ranked within each harness — the arms are not like-for-like' }
        : {}),
    cells,
  };
}

export function axisColumns(summary: SummaryView): AxisColumn[] {
  return summary.axes.map((axis) => axisColumn(summary, axis));
}

/**
 * Do the axes disagree about who won?
 *
 * Compares the **rank each variant received**, not the order the rows happen
 * to sit in. Those become different questions the moment there is a tie: two
 * variants tied at 1.00 have an arbitrary relative order but the same rank,
 * and reading disagreement off their order would make the banner depend on
 * sort stability rather than on the scores.
 *
 * Columns with a rubric mismatch are excluded — they carry no ranks, and a
 * column that is not a ranking cannot disagree with one that is.
 */
export function ranksDisagree(columns: AxisColumn[]): boolean {
  const ranked = columns.filter((c) => !c.mismatched);
  if (ranked.length < 2) return false;

  const byVariant = new Map<string, number[]>();
  for (const column of ranked) {
    for (const cell of column.cells) {
      if (cell.rank === null) continue;
      byVariant.set(cell.variantId, [...(byVariant.get(cell.variantId) ?? []), cell.rank]);
    }
  }
  // One variant placing differently on two axes is the whole finding: strong on
  // one dimension and weak on another, which no single number can say.
  return [...byVariant.values()].some((ranks) => ranks.length > 1 && new Set(ranks).size > 1);
}

export interface CostView {
  text: string;
  /** Why, on hover. A bare number with no explanation is the thing to avoid. */
  title: string;
  unpriced: boolean;
}

/**
 * Cost, honestly.
 *
 * A vendor whose version-free aliases carry no published rate reports
 * `cost_micro_usd: 0` — structurally, not because it was cheap. Rendering that
 * as `$0.00` ranks it first for a reason that has nothing to do with the
 * vendor, so it reads `unpriced` instead and the column is never sortable.
 */
export function formatCost(row: SummaryRowView): CostView {
  const unpriced = Boolean(row.provider && UNPRICED_PROVIDERS.has(row.provider));
  if (unpriced || (row.costMicroUsd === 0 && row.tokensIn + row.tokensOut > 0)) {
    return {
      text: 'unpriced',
      title:
        "this vendor's version-free model aliases carry no published rate, so cost is absent by design — not zero",
      unpriced: true,
    };
  }
  // No model was called at all, so there is no cost to report — a different
  // statement from "this run was free", which is what `$0.0000` would say.
  if (row.tokensIn + row.tokensOut === 0) {
    return { text: '—', title: 'no model calls were recorded for this run', unpriced: true };
  }
  return {
    text: `$${(row.costMicroUsd / 1_000_000).toFixed(4)}`,
    title: `${row.costMicroUsd.toLocaleString()} µUSD`,
    unpriced: false,
  };
}

export interface ToolView {
  headline: string;
  detail: string;
  /** True when the set is mixed and the totals are not like-for-like. */
  caveat: boolean;
}

/**
 * Tool use, split by who supplied the tool.
 *
 * One backend ships its own file tools and the other does not, so a combined
 * total compares two different things and can look like a tie. The headline
 * counts only what the lab registered — the set both vendors actually shared —
 * and built-ins are reported beside it, never folded in.
 */
export function formatTools(row: SummaryRowView): ToolView {
  if (!row.tools) {
    return { headline: `${row.toolCalls} calls`, detail: `${row.toolFailures} failed`, caveat: false };
  }
  const t = row.tools;
  return {
    headline: `${t.registeredCalls} registered`,
    detail: t.hasBuiltins ? `+${t.builtinCalls} built-in · ${t.registeredFailures} failed` : `${t.registeredFailures} failed`,
    caveat: t.hasBuiltins,
  };
}

/** Human text for the warnings the lab computes. */
export function describeWarning(warning: { kind: string; [k: string]: unknown }): string {
  switch (warning.kind) {
    case 'spec_digest_mismatch':
      return `${warning['variantId']} was scored on '${warning['axis']}' under a different rubric — that column is not a ranking`;
    case 'missing_axis':
      return `${warning['variantId']} has no '${warning['axis']}' score, so it is unmeasured on that axis rather than last`;
    case 'cost_incomparable':
      return `cost spans a priced and an unpriced vendor (${(warning['providers'] as string[])?.join(', ')}) — the figures are not comparable`;
    case 'unscored':
      return `${warning['variantId']} has no scores at all`;
    case 'run_missing':
      return `${warning['variantId']} produced no run`;
    case 'tools_not_like_for_like':
      return `tool totals are not like-for-like: ${(warning['variantIds'] as string[])?.join(', ')} had backend-supplied tools as well`;
    case 'harness_mismatch': {
      const bands = (warning['harnesses'] as { impl?: string; harness: string; variantIds: string[] }[]) ?? [];
      const described = bands
        .map((b) => `${b.impl ?? b.harness.slice(0, 8)} (${b.variantIds.join(', ')})`)
        .join(' vs ');
      return `these runs were driven by different harnesses — ${described} — so each axis is ranked within a harness, not across them`;
    }
    default:
      return warning.kind;
  }
}
