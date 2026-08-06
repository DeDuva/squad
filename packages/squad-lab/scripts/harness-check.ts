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
import { SquadClient } from '@deduvafork/squad-sdk/client';
import { VENDORS, type SquadProvider } from '@deduvafork/squad-sdk/config/vendors';

import {
  checkHarnessConformance,
  formatConformance,
  type ConformanceContext,
} from '../src/conformance.js';
import { compareProfiles, formatProfiles, probeWireParity, type WireProfile } from '../src/parity.js';
import { createAiSdkHarness, type AiSdkProvider } from '../src/harnesses/ai-sdk.js';

function geminiKey(): string | undefined {
  if (process.env['GEMINI_API_KEY']) return process.env['GEMINI_API_KEY'];
  const file = join(homedir(), '.config', 'squad', 'gemini.json');
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { apiKey?: string }).apiKey;
  } catch {
    return undefined;
  }
}

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

  const key = provider === 'gemini' ? geminiKey() : undefined;
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

  const key = provider === 'gemini' ? geminiKey() : undefined;
  const client = new SquadClient({
    provider,
    ...(provider === 'gemini' && key ? { geminiApiKey: key } : {}),
    eventBus: bus,
  } as never);
  await client.connect();

  const ctx: ConformanceContext = {
    events: () => [...seen],
    reset: () => {
      seen.length = 0;
    },
    createSession: async (config) =>
      (await (client as unknown as { createSession: (c: unknown) => Promise<unknown> }).createSession({
        model: VENDORS[provider].models.fast,
        clientName: `squad-agent-${config.agentName ?? 'Prober'}`,
        agentName: config.agentName,
        tools: config.tools,
        // The comparable configuration, which is what is being certified.
        availableTools: (config.tools ?? []).map((t) => `mcp__squad__${t.name}`),
        builtinTools: false,
        systemMessage: { mode: 'replace', content: config.systemMessage?.content ?? '' },
        maxToolRounds: config.maxToolRounds,
      })) as never,
  };

  return { ctx, close: async () => void (await (client as unknown as { disconnect?: () => Promise<void> }).disconnect?.()) };
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
    console.log(formatConformance(report));
    failed += report.failed;
    if (wire) {
      ctx.reset();
      profiles.push(await probeWireParity(`ai-sdk:${provider}`, ctx));
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
  if (mismatches.length > 0) {
    console.log(`${mismatches.length} wire difference(s) — any experiment spanning these providers has to account for them`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
