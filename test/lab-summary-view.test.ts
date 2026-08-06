/**
 * The exec summary's rules, which are the product rather than its styling.
 *
 * Every one of these fails silently when broken: a blended number still
 * renders, `0.00` still sorts, and a column scored under two rubrics still
 * looks like a ranking. So each is asserted rather than left to the component.
 */

import { describe, it, expect } from 'vitest';
import {
  axisColumn,
  axisColumns,
  describeWarning,
  formatCost,
  formatScore,
  formatTools,
  ranksDisagree,
  type SummaryView,
} from '../packages/squad-lab/web/src/lib/summary-view.js';

const digest = 'a1bc4151'.repeat(8);
const other = 'b2cd5262'.repeat(8);

function summary(rows: SummaryView['rows'], axes = ['acceptance', 'self-tests']): SummaryView {
  return { experimentId: 'exp_1', intentId: 'intent_1', axes, rows, warnings: [] };
}

const row = (
  variantId: string,
  provider: string,
  evals: { name: string; score: number | null; passed?: boolean; specDigest?: string }[],
  extra: Partial<SummaryView['rows'][number]> = {},
): SummaryView['rows'][number] => ({
  runId: `run_${variantId}`,
  variantId,
  provider,
  eval: null,
  evals: evals.map((e) => ({
    name: e.name,
    score: e.score,
    passed: e.passed ?? (e.score ?? 0) >= 1,
    specDigest: e.specDigest ?? digest,
  })),
  events: 18,
  tokensIn: 1000,
  tokensOut: 100,
  costMicroUsd: 197_000,
  durationMs: 4000,
  toolCalls: 7,
  toolFailures: 0,
  ...extra,
});

// The m8 bake-off's actual result: tied on the module, opposite on the repo's
// own suite. This is the shape the whole product exists to surface.
const BAKE_OFF = summary([
  row('anthropic', 'anthropic', [
    { name: 'acceptance', score: 1 },
    { name: 'self-tests', score: 0 },
  ]),
  row('gemini', 'gemini', [
    { name: 'acceptance', score: 1 },
    { name: 'self-tests', score: 1 },
  ]),
]);

describe('ranking, per column and never blended', () => {
  it('ranks each axis on its own', () => {
    const [acceptance, selfTests] = axisColumns(BAKE_OFF);
    // Tied on acceptance: ties share a rank rather than being broken arbitrarily.
    expect(acceptance!.cells.map((c) => c.rank)).toEqual([1, 1]);
    // And opposite on self-tests, which a mean of the two would have erased.
    expect(selfTests!.cells.map((c) => [c.variantId, c.rank])).toEqual([
      ['gemini', 1],
      ['anthropic', 2],
    ]);
  });

  it('fires the disagreement banner when the axes do not agree on a winner', () => {
    expect(ranksDisagree(axisColumns(BAKE_OFF))).toBe(true);
  });

  it('fires on a tie too, because a tie is a rank and not an ordering', () => {
    // The bake-off's own shape, and the case a browser walk caught: both
    // variants rank #1 on acceptance, but only one ranks #1 on self-tests.
    // Comparing row *order* rather than rank made this depend on sort
    // stability, so the banner fired or not depending on which row came back
    // first from the database.
    const columns = axisColumns(BAKE_OFF);
    expect(columns[0]!.cells.map((c) => c.rank)).toEqual([1, 1]);
    expect(ranksDisagree(columns)).toBe(true);
  });

  it('stays quiet when every axis agrees', () => {
    const agreed = summary([
      row('a', 'anthropic', [
        { name: 'acceptance', score: 1 },
        { name: 'self-tests', score: 1 },
      ]),
      row('b', 'gemini', [
        { name: 'acceptance', score: 0.5 },
        { name: 'self-tests', score: 0.5 },
      ]),
    ]);
    expect(ranksDisagree(axisColumns(agreed))).toBe(false);
  });

  it('does not call one axis a disagreement with itself', () => {
    const single = summary(
      [row('a', 'anthropic', [{ name: 'acceptance', score: 1 }]), row('b', 'gemini', [{ name: 'acceptance', score: 0 }])],
      ['acceptance'],
    );
    expect(ranksDisagree(axisColumns(single))).toBe(false);
  });
});

describe('one rubric per column', () => {
  const mixed = summary(
    [
      row('a', 'anthropic', [{ name: 'acceptance', score: 1 }]),
      row('b', 'gemini', [{ name: 'acceptance', score: 0.4, specDigest: other }]),
    ],
    ['acceptance'],
  );

  it('greys a column whose variants were scored under different rubrics', () => {
    const column = axisColumn(mixed, 'acceptance');
    expect(column.mismatched).toBe(true);
    expect(column.note).toMatch(/different rubrics/);
  });

  it('suppresses its ranks rather than ordering two different measurements', () => {
    expect(axisColumn(mixed, 'acceptance').cells.every((c) => c.rank === null)).toBe(true);
  });

  it('excludes it from the disagreement check, since it ranks nothing', () => {
    expect(ranksDisagree(axisColumns(mixed))).toBe(false);
  });

  it('prints the digest in the header so the rubric is visible, not implied', () => {
    expect(axisColumn(BAKE_OFF, 'acceptance').specDigest).toBe(digest);
  });
});

describe('unscored is not zero', () => {
  it('renders as "not measured" and never as 0.00', () => {
    expect(formatScore(null)).toBe('— not measured');
    expect(formatScore(null)).not.toContain('0.00');
    expect(formatScore(0)).toBe('0.00');
  });

  it('sorts last, and carries no rank', () => {
    const partial = summary(
      [
        row('a', 'anthropic', [{ name: 'acceptance', score: null }]),
        row('b', 'gemini', [{ name: 'acceptance', score: 0 }]),
      ],
      ['acceptance'],
    );
    const cells = axisColumn(partial, 'acceptance').cells;
    // A run that scored zero is measured and beats one that was not measured
    // at all — the opposite of what treating null as 0 would produce.
    expect(cells.map((c) => c.variantId)).toEqual(['b', 'a']);
    expect(cells.map((c) => c.rank)).toEqual([1, null]);
  });

  it('treats a variant missing the axis entirely as unmeasured, not as last place', () => {
    const missing = summary(
      [row('a', 'anthropic', [{ name: 'acceptance', score: 1 }]), row('b', 'gemini', [])],
      ['acceptance'],
    );
    const b = axisColumn(missing, 'acceptance').cells.find((c) => c.variantId === 'b')!;
    expect(b.score).toBeNull();
    expect(b.rank).toBeNull();
  });
});

describe('cost, honestly', () => {
  it('renders an unpriced vendor as unpriced, never as $0.00', () => {
    const cost = formatCost(row('gemini', 'gemini', [], { costMicroUsd: 0 }));
    expect(cost.text).toBe('unpriced');
    expect(cost.unpriced).toBe(true);
    expect(cost.title).toMatch(/not zero/);
  });

  it('renders a priced vendor as money', () => {
    expect(formatCost(row('anthropic', 'anthropic', [])).text).toBe('$0.1970');
  });

  it('says "no model calls" rather than $0.0000 when nothing was spent on models', () => {
    // A run with no model calls has no cost to report, which is a different
    // statement from "this run was free" — and `$0.0000` makes the second one.
    const empty = formatCost(row('anthropic', 'anthropic', [], { costMicroUsd: 0, tokensIn: 0, tokensOut: 0 }));
    expect(empty.text).toBe('—');
    expect(empty.text).not.toContain('0.00');
    expect(empty.title).toMatch(/no model calls/);
  });

  it('still reports a priced vendor that did spend as unpriced only when the rate is missing', () => {
    const noRate = formatCost(row('anthropic', 'anthropic', [], { costMicroUsd: 0, tokensIn: 500 }));
    expect(noRate.text).toBe('unpriced');
  });

  it('says so when the set spans a priced and an unpriced vendor', () => {
    expect(describeWarning({ kind: 'cost_incomparable', providers: ['gemini'] })).toMatch(/not comparable/);
  });
});

describe('tool counts are not like-for-like', () => {
  it('headlines the registered tools both vendors shared, and flags the rest', () => {
    const withBuiltins = formatTools(
      row('anthropic', 'anthropic', [], {
        tools: {
          registered: [{ name: 'write_file', count: 4, failures: 0 }],
          builtin: [{ name: 'Read', count: 9, failures: 1 }],
          registeredCalls: 4,
          registeredFailures: 0,
          builtinCalls: 9,
          hasBuiltins: true,
        },
      }),
    );
    // 13 would look like more work done; 4 is the number that compares.
    expect(withBuiltins.headline).toBe('4 registered');
    expect(withBuiltins.detail).toContain('+9 built-in');
    expect(withBuiltins.caveat).toBe(true);
  });
});
