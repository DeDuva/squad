/**
 * Cost, and the difference between "free" and "we do not know".
 *
 * The neutral loop reported `cost_micro_usd: 0` for every run because the AI
 * SDK gives tokens and leaves pricing to the caller. The SDK's own
 * `estimateCost` has the same shape — `0` for a model it has never heard of.
 * Both produce a number that reads as free and means unknown, which is the same
 * failure as scoring an unmeasured run as zero, one column over.
 *
 * The rates themselves are checked against the provider's arithmetic by
 * `scripts/pricing-check.ts`, not here: a unit test can only confirm that the
 * table is applied consistently, never that it is *right*.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRICE_TABLE,
  priceTableDigest,
  priceUsage,
  toMicroUsd,
  type PriceTable,
} from '../packages/squad-lab/src/pricing.ts';

const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };

describe('unpriced is not free', () => {
  it('returns null for a model with no rate', () => {
    const priced = priceUsage('a-model-nobody-has-heard-of', usage);
    expect(priced.costUsd).toBeNull();
    expect(priced.basis).toBe('unpriced');
  });

  it('keeps a deliberately unpriced vendor unpriced', () => {
    // Gemini's version-free aliases carry no published rate. Absent from the
    // table is the true answer, and inventing one would be the fastest way to
    // make the whole apparatus dishonest.
    expect(priceUsage('gemini-flash-latest', usage).costUsd).toBeNull();
  });

  it('turns an unpriced result into an absent field, never a zero', () => {
    // ADP and CostTracker both read a missing figure as "no figure" and a `0`
    // as "this was free".
    expect(toMicroUsd(null)).toBeUndefined();
    expect(toMicroUsd(0)).toBe(0);
  });

  it('distinguishes a genuinely zero reported cost from an unknown one', () => {
    // A provider that priced the call and said zero is answering; a table that
    // has no entry is not.
    const reportedFree = priceUsage('anything', usage, { reportedUsd: 0 });
    expect(reportedFree.costUsd).toBe(0);
    expect(reportedFree.basis).toBe('reported');
  });
});

describe('what the price is based on, recorded', () => {
  it('prefers a cost the provider reported over any table', () => {
    // The backend accounts for cache terms and knows which model truly served
    // the turn; a catalogue is a guess about both.
    const priced = priceUsage('claude-haiku-4-5', usage, { reportedUsd: 0.42 });
    expect(priced).toMatchObject({ costUsd: 0.42, basis: 'reported' });
    expect(priced.tableDigest).toBeUndefined();
  });

  it('stamps the table it used, so two runs priced differently are visible', () => {
    const priced = priceUsage('claude-haiku-4-5', usage);
    expect(priced.basis).toBe('table');
    expect(priced.tableId).toBe('anthropic-published');
    expect(priced.tableDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the digest when a rate moves', () => {
    const bumped: PriceTable = {
      ...DEFAULT_PRICE_TABLE,
      rates: {
        ...DEFAULT_PRICE_TABLE.rates,
        'claude-haiku-4-5': { inputPerToken: 2e-6, outputPerToken: 5e-6 },
      },
    };
    // Same idea as `spec_digest`: two numbers produced under different rates
    // are not comparable, and the digest is what makes that checkable rather
    // than something a reader has to remember.
    expect(priceTableDigest(bumped)).not.toBe(priceTableDigest(DEFAULT_PRICE_TABLE));
  });
});

describe('cache tokens', () => {
  it('bills cache reads far below fresh input', () => {
    const fresh = priceUsage('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0 }).costUsd!;
    const cached = priceUsage('claude-haiku-4-5', {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    }).costUsd!;
    // A long agent turn is mostly cache reads. Pricing them as ordinary input
    // overstates a run several times over — the M12 runs carried 400k+ input
    // tokens each.
    expect(cached).toBeLessThan(fresh / 5);
    expect(cached).toBeGreaterThan(0);
  });

  it('bills cache writes above fresh input', () => {
    const fresh = priceUsage('claude-haiku-4-5', { inputTokens: 1_000, outputTokens: 0 }).costUsd!;
    const written = priceUsage('claude-haiku-4-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000,
    }).costUsd!;
    expect(written).toBeGreaterThan(fresh);
  });

  it('falls back to the input rate rather than to zero for an unknown cache term', () => {
    const table: PriceTable = {
      id: 'partial',
      asOf: '2026-01-01',
      rates: { m: { inputPerToken: 1e-6, outputPerToken: 2e-6 } },
    };
    // A table that knows the model but not its cache terms should over-report
    // slightly, never bill the bulk of a turn at nothing.
    const priced = priceUsage('m', { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000 }, { table });
    expect(priced.costUsd).toBeCloseTo(1_000 * 1e-6, 12);
  });
});
