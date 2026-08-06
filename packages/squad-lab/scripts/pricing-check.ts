/**
 * Check the price table against the provider's own arithmetic.
 *
 * A price table is a claim. This is what turns it into a checked one: run the
 * same prompt through the native Anthropic backend — which reports what the
 * turn actually cost — and price the identical token counts from the table.
 * If the two disagree by more than rounding, the table is wrong, or the
 * accounting is (are cache reads inside `inputTokens` or beside them?), and
 * either way the number the lab reports is not the number the vendor bills.
 *
 * That question is not answerable by reading documentation, which is why this
 * exists rather than a comment asserting the rates are right.
 *
 *   set -a; . ~/.config/squad/anthropic.env; set +a
 *   npm run pricing-check -w @deduvafork/squad-lab
 */

import { EventBus, type SquadEvent } from '@deduvafork/squad-sdk/runtime/event-bus';
import { SquadClient } from '@deduvafork/squad-sdk/client';

import { DEFAULT_PRICE_TABLE, priceUsage } from '../src/pricing.js';

const MODEL = process.env['PRICING_CHECK_MODEL'] ?? 'claude-haiku-4-5';
/** Long enough that cache reads and a real token count are in play. */
const PROMPT =
  'Summarise, in one sentence each, what these do: a CSV tokenizer, a duration parser, ' +
  'a benchmark harness, a path jail, and a hash-chained trajectory recorder.';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.log('ANTHROPIC_API_KEY is not set — load ~/.config/squad/anthropic.env');
    process.exit(1);
  }

  const bus = new EventBus();
  const usages: Record<string, unknown>[] = [];
  bus.subscribeAll((e: SquadEvent) => {
    if (String(e.type) === 'session:model_usage') usages.push(e.payload as Record<string, unknown>);
  });

  const client = new SquadClient({ provider: 'anthropic', eventBus: bus } as never);
  await client.connect();

  const session = (await (client as unknown as { createSession: (c: unknown) => Promise<unknown> }).createSession({
    model: MODEL,
    clientName: 'squad-agent-Pricer',
    agentName: 'Pricer',
    // No tools: this is about token accounting, not about agent behaviour.
    systemMessage: { mode: 'replace', content: 'Answer concisely.' },
  })) as { sendAndWait?: (o: { prompt: string }, t?: number) => Promise<unknown>; close?: () => Promise<void> };

  await session.sendAndWait?.({ prompt: PROMPT }, 120_000);
  await session.close?.();

  const usage = usages.at(-1);
  if (!usage) {
    check('the backend reported usage at all', false);
    process.exit(1);
  }

  const inputTokens = Number(usage['inputTokens'] ?? 0);
  const outputTokens = Number(usage['outputTokens'] ?? 0);
  const cachedInputTokens = Number(usage['cacheReadInputTokens'] ?? 0);
  const cacheWriteTokens = Number(usage['cacheCreationInputTokens'] ?? 0);
  const reported = usage['estimatedCost'];

  console.log(
    `\n${MODEL}: in=${inputTokens} out=${outputTokens} cacheRead=${cachedInputTokens} cacheWrite=${cacheWriteTokens}`,
  );

  check('the backend reported a real cost to compare against', typeof reported === 'number' && reported > 0, reported);
  if (typeof reported !== 'number' || reported === 0) {
    console.log('\nwithout a reported cost there is nothing to check the table against');
    process.exit(1);
  }

  const priced = priceUsage(MODEL, { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens });
  const table = priced.costUsd ?? 0;
  const drift = Math.abs(table - reported) / reported;

  console.log(`  reported $${reported.toFixed(6)}   table $${table.toFixed(6)}   drift ${(drift * 100).toFixed(1)}%`);

  // 5% absorbs rounding and any minor term the table does not model. Anything
  // larger means the *structure* is wrong — a rate off by a factor, or cache
  // tokens being double-counted — not that a price moved a little.
  check('the table agrees with the provider within 5%', drift <= 0.05, {
    reported,
    table,
    drift: Number((drift * 100).toFixed(2)),
    asOf: DEFAULT_PRICE_TABLE.asOf,
  });

  // The property the whole fix turns on.
  const unknown = priceUsage('a-model-nobody-has-heard-of', { inputTokens: 1_000_000, outputTokens: 1_000 });
  check('an unknown model prices as unpriced, not as free', unknown.costUsd === null && unknown.basis === 'unpriced');
  const gemini = priceUsage('gemini-flash-latest', { inputTokens: 1_000_000, outputTokens: 1_000 });
  check('a deliberately unpriced vendor stays unpriced', gemini.costUsd === null);

  console.log(failures === 0 ? '\nthe price table holds' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
