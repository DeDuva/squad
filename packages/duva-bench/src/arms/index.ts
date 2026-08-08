/**
 * Opening an arm, which is the only place the two loops are told apart.
 *
 * Both arms are `SessionFactory`s — squad-lab's conformance suite judges that
 * interface and both satisfy it — so everything downstream of this file treats
 * them identically. That is the property S1 is really buying: the runner has no
 * branch on which harness it is driving, so a difference between two arms
 * cannot come from the runner treating them differently.
 */

import { VENDORS } from '@deduvafork/squad-sdk/config/vendors';
import { createAiSdkHarness, type AiSdkProvider } from '@deduvafork/squad-lab/harnesses/ai-sdk';
import { createNativeHarness } from '@deduvafork/squad-lab/harnesses/native';

import type { ArmSpec, OpenArm, OpenArmContext } from './types.js';

export type { ArmHarness, ArmSpec, OpenArm, OpenArmContext } from './types.js';

/** The model an arm resolves to, without connecting anything. */
export function resolveArmModel(spec: ArmSpec): string {
  return spec.model ?? VENDORS[spec.provider].models[spec.tier ?? 'standard'];
}

export async function openArm(spec: ArmSpec, ctx: OpenArmContext): Promise<OpenArm> {
  const model = resolveArmModel(spec);

  if (spec.harness === 'swarm') {
    // Refused rather than approximated. Running a single agent under a
    // `topology: swarm` label would put a false field on an attested run, and
    // the whole point of recording the topology is that it is checkable.
    throw new Error("arm harness 'swarm' arrives in S4; see src/arms/swarm.ts");
  }

  if (spec.harness === 'ai-sdk') {
    const createSession = createAiSdkHarness({
      bus: ctx.bus,
      provider: spec.provider as AiSdkProvider,
      model,
      ...(spec.maxToolRounds !== undefined ? { defaultMaxToolRounds: spec.maxToolRounds } : {}),
      // Passed, never inherited. The neutral loop is the one arm that has no
      // business reading the ambient environment, since not reading it is what
      // it is for.
      ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
    });
    return { createSession, model, close: async () => {} };
  }

  const native = await createNativeHarness({
    bus: ctx.bus,
    provider: spec.provider,
    model,
    workingDirectory: ctx.workingDirectory,
    ...(spec.toolSurface ? { toolSurface: spec.toolSurface } : {}),
    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.maxToolRounds !== undefined ? { defaultMaxToolRounds: spec.maxToolRounds } : {}),
    ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
  });

  return { createSession: native.createSession, model, close: native.close };
}
