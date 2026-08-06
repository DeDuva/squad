/**
 * What a run cost, and how confident we are allowed to be about it.
 *
 * The neutral loop reports token usage and no cost — the AI SDK leaves pricing
 * to the caller — so its runs arrived with `cost_micro_usd: 0`. That is the
 * fifth instance of this project's recurring failure: a number that means
 * "unknown" rendered as a number that means "free", where nothing downstream
 * can tell them apart. `estimateCost` in the SDK has the same shape, returning
 * `0` for a model it has never heard of.
 *
 * So the rule here is the same one `spec_digest` enforces for rubrics, one
 * layer over:
 *
 *  1. **A price the provider reported beats any table.** It accounts for cache
 *     reads, cache writes, and whichever model actually served the turn.
 *  2. **A table price is a claim, so it carries its provenance.** Every priced
 *     run records the table's digest and its `asOf` date, and two runs priced
 *     under different tables are as incomparable as two scored under different
 *     rubrics.
 *  3. **A model with no entry is `null`, never `0`.** Unpriced and free are
 *     opposite claims and the difference is invisible once it becomes a number.
 *
 * The table below is checkable rather than merely asserted: running one model
 * under the native harness (which reports real cost) and the neutral loop
 * (which prices from this table) on identical work compares the two, and
 * `scripts/pricing-check.ts` does exactly that.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from './grader.js';

/** Per-token rates in USD. Absent fields mean "bill at the input rate". */
export interface TokenRates {
  inputPerToken: number;
  outputPerToken: number;
  /**
   * Cache **reads**. Anthropic bills these at a tenth of the input rate, which
   * is not a rounding difference: a long agent turn is mostly cache reads, so
   * pricing them at the base rate overstates a run several times over.
   */
  cachedInputPerToken?: number;
  /** Cache **writes**, billed above the input rate for the 5-minute TTL. */
  cacheWritePerToken?: number;
}

export interface PriceTable {
  /** Human name, recorded on the run beside the digest. */
  id: string;
  /** When these rates were last checked against the vendor's published list. */
  asOf: string;
  /** Keyed by model id. A missing key means unpriced, not free. */
  rates: Record<string, TokenRates>;
}

/**
 * Rates as published for the models this lab runs.
 *
 * Deliberately small. A table that tries to cover every model is a table nobody
 * re-checks, and a stale rate is worse than an absent one — an absent one says
 * `unpriced` and a stale one says a number.
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  id: 'anthropic-published',
  asOf: '2026-08-06',
  rates: {
    'claude-opus-5': {
      inputPerToken: 5e-6,
      outputPerToken: 25e-6,
      cachedInputPerToken: 0.5e-6,
      cacheWritePerToken: 6.25e-6,
    },
    'claude-sonnet-5': {
      inputPerToken: 3e-6,
      outputPerToken: 15e-6,
      cachedInputPerToken: 0.3e-6,
      cacheWritePerToken: 3.75e-6,
    },
    'claude-haiku-4-5': {
      inputPerToken: 1e-6,
      outputPerToken: 5e-6,
      cachedInputPerToken: 0.1e-6,
      cacheWritePerToken: 1.25e-6,
    },
    // Gemini's version-free aliases are deliberately absent. They carry no
    // published rate — a number pinned to a moving alias is wrong the moment it
    // moves — so they price as `unpriced`, which is the true answer.
  },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cache reads. Assumed **disjoint** from `inputTokens`, as both SDKs report. */
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

/** How a cost figure was arrived at. Recorded, because it decides comparability. */
export type CostBasis = 'reported' | 'table' | 'unpriced';

export interface PricedUsage {
  /** USD, or `null` when the model has no rate. Never `0` to mean unknown. */
  costUsd: number | null;
  basis: CostBasis;
  /** Present when `basis` is `table`. */
  tableId?: string;
  tableDigest?: string;
}

export function priceTableDigest(table: PriceTable): string {
  return createHash('sha256').update(canonicalJson(table), 'utf8').digest('hex');
}

/**
 * Price one model invocation.
 *
 * `reportedUsd` wins whenever the provider gave one — including `0`, which from
 * a provider that priced the call is a real answer rather than a missing one.
 */
export function priceUsage(
  model: string,
  usage: TokenUsage,
  options: { table?: PriceTable; reportedUsd?: number | null } = {},
): PricedUsage {
  if (typeof options.reportedUsd === 'number' && Number.isFinite(options.reportedUsd)) {
    return { costUsd: options.reportedUsd, basis: 'reported' };
  }

  const table = options.table ?? DEFAULT_PRICE_TABLE;
  const rates = table.rates[model];
  if (!rates) return { costUsd: null, basis: 'unpriced' };

  // Cache rates fall back to the input rate rather than to zero: a table that
  // knows the model but not its cache terms should over-report slightly, not
  // silently bill the bulk of a turn at nothing.
  const cachedRate = rates.cachedInputPerToken ?? rates.inputPerToken;
  const writeRate = rates.cacheWritePerToken ?? rates.inputPerToken;

  const costUsd =
    usage.inputTokens * rates.inputPerToken +
    usage.outputTokens * rates.outputPerToken +
    (usage.cachedInputTokens ?? 0) * cachedRate +
    (usage.cacheWriteTokens ?? 0) * writeRate;

  return {
    costUsd,
    basis: 'table',
    tableId: table.id,
    tableDigest: priceTableDigest(table),
  };
}

/** USD → the integer micro-USD ADP stores. `null` stays absent, not zero. */
export function toMicroUsd(costUsd: number | null): number | undefined {
  return costUsd === null ? undefined : Math.round(costUsd * 1_000_000);
}
