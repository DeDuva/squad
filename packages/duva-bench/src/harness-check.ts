/**
 * The conformance gate, run against arms as `openArm` actually builds them.
 *
 * squad-lab already has a `harness-check`, and it certifies the same two
 * factories. This one exists because SG1's claim is narrower and stronger: not
 * "the neutral loop and the native backend both conform" but "the arms this
 * runner will drive both conform". The difference is the assembly — the model
 * resolution, the parity settings, the key handling in `openArm` — which is
 * exactly the layer a benchmark can get wrong while both underlying harnesses
 * remain fine.
 *
 * Costs a few model calls per arm and no ADP.
 */

import { EventBus, type SquadEvent } from '@deduvafork/squad-sdk/runtime/event-bus';
import {
  checkHarnessConformance,
  formatConformance,
  type ConformanceContext,
  type ConformanceReport,
} from '@deduvafork/squad-lab/conformance';

import { openArm, resolveArmModel } from './arms/index.js';
import type { ArmSpec } from './arms/types.js';
import { vendorKey } from './credentials.js';

export interface ArmConformance {
  armId: string;
  report: ConformanceReport;
}

/** Certify one arm. The caller owns the decision to skip a keyless provider. */
export async function checkArm(spec: ArmSpec, workingDirectory: string): Promise<ArmConformance> {
  const bus = new EventBus();
  const seen: SquadEvent[] = [];
  bus.subscribeAll((e) => {
    seen.push(e);
  });

  const key = vendorKey(spec.provider);
  const arm = await openArm(spec, {
    bus,
    workingDirectory,
    ...(key ? { apiKey: key } : {}),
  });

  const ctx: ConformanceContext = {
    events: () => [...seen],
    reset: () => {
      seen.length = 0;
    },
    createSession: (config) => arm.createSession({ ...config, agentName: config.agentName ?? 'Prober' }),
  };

  try {
    return { armId: spec.id, report: await checkHarnessConformance(spec.id, ctx) };
  } finally {
    await arm.close();
  }
}

/**
 * The two in-process arms for one provider, on the vendor's cheapest model.
 *
 * `fast` deliberately: the gate is about the harness, and paying premium rates
 * to learn that a tool round limit is enforced would make it a gate nobody runs.
 */
export function defaultArms(provider: ArmSpec['provider']): ArmSpec[] {
  return [
    { id: `squad-native:${provider}`, harness: 'squad-native', provider, tier: 'fast' },
    { id: `ai-sdk:${provider}`, harness: 'ai-sdk', provider, tier: 'fast' },
  ];
}

export interface HarnessCheckResult {
  results: ArmConformance[];
  skipped: Array<{ armId: string; reason: string }>;
  failed: number;
  output: string;
}

export async function runHarnessCheck(
  providers: Array<ArmSpec['provider']>,
  workingDirectory: string,
): Promise<HarnessCheckResult> {
  const lines: string[] = [];
  const results: ArmConformance[] = [];
  const skipped: HarnessCheckResult['skipped'] = [];
  let failed = 0;

  for (const provider of providers) {
    for (const spec of defaultArms(provider)) {
      // The native Anthropic backend wraps the `claude` CLI and inherits its
      // credential chain, so it alone can run without a key of its own.
      const needsKey = !(provider === 'anthropic' && spec.harness === 'squad-native');
      if (needsKey && !vendorKey(provider)) {
        skipped.push({ armId: spec.id, reason: `no key for ${provider}` });
        lines.push(`\n=== ${spec.id}\nskipped — no key for ${provider}`);
        continue;
      }

      lines.push(`\n=== ${spec.id} (${resolveArmModel(spec)})`);
      try {
        const result = await checkArm(spec, workingDirectory);
        results.push(result);
        failed += result.report.failed;
        lines.push(formatConformance(result.report));
      } catch (error) {
        failed += 1;
        lines.push(`arm failed to open: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  lines.push(failed === 0 ? '\nevery arm conforms' : `\n${failed} clause failure(s)`);
  return { results, skipped, failed, output: `${lines.join('\n')}\n` };
}
