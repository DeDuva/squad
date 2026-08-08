/**
 * Run the harness contract against the real backends.
 *
 * The offline tests prove the suite catches a harness that misbehaves. This
 * proves the harnesses we actually ship do not — which is a different claim,
 * and the one that was false: before the budget moved into `adapter/client.ts`,
 * Gemini stopped at ten tool rounds and threw, Anthropic had no ceiling at all,
 * and a comparison across them measured that difference and called it a model.
 *
 * Costs a few model calls per backend and no ADP.
 *
 *   npm run harness-check -w @deduvafork/squad-lab            # both
 *   npm run harness-check -w @deduvafork/squad-lab -- gemini  # one
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EventBus, type SquadEvent } from '@deduvafork/squad-sdk/runtime/event-bus';
import { VENDORS, type SquadProvider } from '@deduvafork/squad-sdk/config/vendors';

import {
  checkHarnessConformance,
  compareTelemetry,
  formatConformance,
  formatTelemetryDiff,
  type ConformanceContext,
  type ConformanceReport,
} from '../src/conformance.js';
import { compareProfiles, formatProfiles, probeWireParity, type WireProfile } from '../src/parity.js';
import { createAiSdkHarness, type AiSdkProvider } from '../src/harnesses/ai-sdk.js';
import { createNativeHarness } from '../src/harnesses/native.js';

function vendorKey(provider: SquadProvider): string | undefined {
  const fromEnv = process.env[VENDORS[provider].apiKeyEnv];
  if (fromEnv) return fromEnv;
  const file = join(homedir(), '.config', 'squad', `${provider}.json`);
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { apiKey?: string }).apiKey;
  } catch {
    return undefined;
  }
}

const geminiKey = () => vendorKey('gemini');

/**
 * The neutral loop, as a harness the same suite can judge.
 *
 * Named `ai-sdk:<provider>` so a report shows it beside the native one rather
 * than instead of it — the interesting number is the difference.
 */
async function aiSdkContextFor(provider: AiSdkProvider): Promise<{ ctx: ConformanceContext; close: () => Promise<void> }> {
  const bus = new EventBus();
  const seen: SquadEvent[] = [];
  bus.subscribeAll((e) => {
    seen.push(e);
  });

  // Both vendors now, not just Gemini: the neutral loop takes its key
  // explicitly for either provider rather than reading one from the ambient
  // environment for one of them.
  const key = vendorKey(provider);
  const createSession = createAiSdkHarness({
    bus,
    provider,
    model: VENDORS[provider].models.fast,
    ...(key ? { apiKey: key } : {}),
  });

  return {
    ctx: { events: () => [...seen], reset: () => { seen.length = 0; }, createSession },
    close: async () => {},
  };
}

async function contextFor(provider: SquadProvider): Promise<{ ctx: ConformanceContext; close: () => Promise<void> }> {
  const bus = new EventBus();
  const seen: SquadEvent[] = [];
  bus.subscribeAll((e) => {
    seen.push(e);
  });

  // The shared factory, not a copy of it. This script used to rebuild the
  // native arm inline, and the copy had drifted: it always replaced the system
  // message and always filtered tools, so it certified a configuration no
  // variant necessarily ran. Certifying `createNativeHarness` means the arm
  // that passes here is the arm duva-bench executes.
  const key = provider === 'gemini' ? geminiKey() : undefined;
  const native = await createNativeHarness({
    bus,
    provider,
    model: VENDORS[provider].models.fast,
    ...(key ? { apiKey: key } : {}),
  });

  const ctx: ConformanceContext = {
    events: () => [...seen],
    reset: () => {
      seen.length = 0;
    },
    createSession: (config) =>
      native.createSession({
        ...config,
        agentName: config.agentName ?? 'Prober',
      }),
  };

  return { ctx, close: native.close };
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const providers = (requested.length > 0 ? requested : ['anthropic', 'gemini']) as SquadProvider[];
  // `--ai-sdk` alone runs every provider the loop can reach; `--ai-sdk=gemini`
  // picks one.
  const aiSdkArg = process.argv.find((a) => a.startsWith('--ai-sdk'));
  const withAiSdk: AiSdkProvider[] = !aiSdkArg
    ? []
    : aiSdkArg.includes('=')
      ? (aiSdkArg.split('=')[1]!.split(',') as AiSdkProvider[])
      : (['anthropic', 'gemini'] as AiSdkProvider[]);

  let failed = 0;
  const profiles: WireProfile[] = [];
  // Kept so the two arms for one provider can be diffed against each other.
  const reports = new Map<string, ConformanceReport>();
  const wire = !process.argv.includes('--no-wire');
  for (const provider of providers) {
    if (provider === 'gemini' && !geminiKey()) {
      console.log(`\nskipping gemini — no key in GEMINI_API_KEY or ~/.config/squad/gemini.json`);
      continue;
    }
    console.log(`\n=== ${provider}`);
    const { ctx, close } = await contextFor(provider);
    try {
      const report = await checkHarnessConformance(provider, ctx);
      reports.set(`squad-native:${provider}`, report);
      console.log(formatConformance(report));
      failed += report.failed;
      if (wire) {
        ctx.reset();
        profiles.push(await probeWireParity(provider, ctx));
      }
    } finally {
      await close();
    }
  }

  for (const provider of withAiSdk) {
    if (provider === 'gemini' && !geminiKey()) continue;
    console.log(`\n=== ai-sdk:${provider}`);
    const { ctx } = await aiSdkContextFor(provider);
    const report = await checkHarnessConformance(`ai-sdk:${provider}`, ctx);
    reports.set(`ai-sdk:${provider}`, report);
    console.log(formatConformance(report));
    failed += report.failed;
    if (wire) {
      ctx.reset();
      profiles.push(await probeWireParity(`ai-sdk:${provider}`, ctx));
    }
  }

  // The two arms for one provider, diffed on what reached the bus. Unlike a
  // wire mismatch this *is* a harness bug: the same model doing the same work
  // under two loops must leave the same kinds of trace, or the trajectories are
  // not comparable and the difference gets attributed to the model.
  let telemetryMismatches = 0;
  const pairs = [...reports.keys()]
    .filter((k) => k.startsWith('ai-sdk:'))
    .map((k) => [`squad-native:${k.slice('ai-sdk:'.length)}`, k] as const)
    .filter(([native]) => reports.has(native));
  if (pairs.length > 0) {
    console.log('\n=== telemetry parity');
    for (const [native, neutral] of pairs) {
      const diff = compareTelemetry(reports.get(native)!, reports.get(neutral)!);
      console.log(formatTelemetryDiff(native, neutral, diff));
      // Only a missing *required* type fails. A conditional difference is
      // printed above and left for a human, because whether a probe run
      // exhausted its budget is the model's decision, not the harness's.
      if (!diff.ok) telemetryMismatches += 1;
    }
  }

  if (profiles.length > 0) {
    console.log('\n=== wire parity');
    console.log(formatProfiles(profiles));
  }
  // A capability mismatch is not a harness bug — it is a fact about the
  // providers, and the experiment that spans them is what it invalidates. So it
  // is reported loudly and does not fail the check.
  const mismatches = compareProfiles(profiles);

  console.log(failed === 0 ? '\nevery harness conforms' : `\n${failed} clause failure(s)`);
  if (telemetryMismatches > 0) {
    console.log(`${telemetryMismatches} telemetry mismatch(es) — the arms do not record the same kinds of event`);
  }
  if (mismatches.length > 0) {
    console.log(`${mismatches.length} wire difference(s) — any experiment spanning these providers has to account for them`);
  }
  process.exit(failed === 0 && telemetryMismatches === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
