/**
 * What a summary does when the rows were not driven by the same harness.
 *
 * Running one model under two loops is the comparison this lab exists for, so
 * the table has to hold both — but a single ranking across them would read as a
 * statement about the models, which is the exact mistake the harness digest was
 * introduced to stop. Ranks are therefore computed within a harness, and the
 * fact that there is more than one is said out loud.
 */

import { describe, it, expect } from 'vitest';

import {
  axisColumn,
  describeWarning,
  type SummaryView,
} from '../packages/squad-lab/web/src/lib/summary-view.js';

const digest = 'a1bc4151'.repeat(8);
const NATIVE = 'f6d5184a'.repeat(8);
const NEUTRAL = '0b91cc27'.repeat(8);

const row = (
  variantId: string,
  score: number,
  harness: string,
  harnessImpl: string,
): SummaryView['rows'][number] => ({
  runId: `run_${variantId}`,
  variantId,
  provider: variantId.startsWith('anthropic') ? 'anthropic' : 'gemini',
  labels: { harness, harness_impl: harnessImpl, model: 'claude-sonnet-5' },
  eval: null,
  evals: [{ name: 'acceptance', score, passed: score >= 1, specDigest: digest }],
  events: 18,
  tokensIn: 1000,
  tokensOut: 100,
  costMicroUsd: 197_000,
  durationMs: 4000,
  toolCalls: 7,
  toolFailures: 0,
});

const summary = (rows: SummaryView['rows']): SummaryView => ({
  experimentId: 'exp_1',
  intentId: 'intent_1',
  axes: ['acceptance'],
  rows,
  warnings: [],
});

describe('an axis spanning two harnesses', () => {
  // The four-cell matrix: one model per vendor, each under both arms.
  const MATRIX = summary([
    row('anthropic-native', 0.9, NATIVE, 'squad-native'),
    row('anthropic-aisdk', 0.7, NEUTRAL, 'ai-sdk'),
    row('gemini-native', 0.5, NATIVE, 'squad-native'),
    row('gemini-aisdk', 0.6, NEUTRAL, 'ai-sdk'),
  ]);

  it('is marked as banded', () => {
    expect(axisColumn(MATRIX, 'acceptance').banded).toBe(true);
    expect(axisColumn(MATRIX, 'acceptance').note).toContain('within each harness');
  });

  it('ranks within a harness, not across the column', () => {
    const cells = axisColumn(MATRIX, 'acceptance').cells;
    const rankOf = (v: string) => cells.find((c) => c.variantId === v)!.rank;

    // Two firsts, one per arm — not a single 1..4 ordering. Without banding
    // `gemini-aisdk` (0.6) would place third overall and read as beaten by a
    // native run it never shared a harness with.
    expect(rankOf('anthropic-native')).toBe(1);
    expect(rankOf('gemini-native')).toBe(2);
    expect(rankOf('anthropic-aisdk')).toBe(1);
    expect(rankOf('gemini-aisdk')).toBe(2);
  });

  it('carries the attested harness onto each cell', () => {
    const cell = axisColumn(MATRIX, 'acceptance').cells.find((c) => c.variantId === 'anthropic-aisdk')!;
    expect(cell.harness).toBe(NEUTRAL);
    expect(cell.harnessImpl).toBe('ai-sdk');
  });

  it('still ranks across the column when one harness drove everything', () => {
    const oneArm = summary([
      row('anthropic-native', 0.9, NATIVE, 'squad-native'),
      row('gemini-native', 0.5, NATIVE, 'squad-native'),
    ]);
    const column = axisColumn(oneArm, 'acceptance');
    expect(column.banded).toBe(false);
    expect(column.note).toBeUndefined();
    expect(column.cells.find((c) => c.variantId === 'gemini-native')!.rank).toBe(2);
  });

  it('lets a rubric mismatch still win over banding', () => {
    // A column scored under two rubrics is not a ranking at all, banded or not.
    const mixed = summary([
      row('anthropic-native', 0.9, NATIVE, 'squad-native'),
      { ...row('anthropic-aisdk', 0.7, NEUTRAL, 'ai-sdk'), evals: [{ name: 'acceptance', score: 0.7, passed: false, specDigest: 'ff'.repeat(32) }] },
    ]);
    const column = axisColumn(mixed, 'acceptance');
    expect(column.mismatched).toBe(true);
    expect(column.cells.every((c) => c.rank === null)).toBe(true);
  });
});

describe('the harness_mismatch warning', () => {
  it('names both arms and the variants in each', () => {
    const text = describeWarning({
      kind: 'harness_mismatch',
      harnesses: [
        { harness: NATIVE, impl: 'squad-native', variantIds: ['anthropic-native', 'gemini-native'] },
        { harness: NEUTRAL, impl: 'ai-sdk', variantIds: ['anthropic-aisdk', 'gemini-aisdk'] },
      ],
    });
    expect(text).toContain('squad-native');
    expect(text).toContain('ai-sdk');
    expect(text).toContain('anthropic-native');
    expect(text).toContain('within a harness, not across them');
  });

  it('falls back to a short digest when no impl label was recorded', () => {
    // An older run, or one opened by a producer that did not label itself.
    const text = describeWarning({
      kind: 'harness_mismatch',
      harnesses: [
        { harness: NATIVE, variantIds: ['a'] },
        { harness: NEUTRAL, variantIds: ['b'] },
      ],
    });
    expect(text).toContain(NATIVE.slice(0, 8));
  });
});
