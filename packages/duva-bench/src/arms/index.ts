/**
 * Opening an arm, which is the only place the loops and topologies are told apart.
 *
 * Both loops are `SessionFactory`s — squad-lab's conformance suite judges that
 * interface and both satisfy it — so everything downstream treats them
 * identically. That is the property S1 bought: the runner has no branch on
 * which harness it drives, so a difference between two arms cannot come from
 * the runner treating them differently.
 *
 * A swarm arm composes rather than replaces. It takes whichever loop the arm
 * names and puts a coordinator in front of it, so `ai-sdk × single` and
 * `ai-sdk × swarm` differ in exactly one thing. `./swarm.js` is imported
 * dynamically and only when it is needed, so a single-agent trial never loads
 * `SquadCoordinator` at all — the boundary says only that file *may* import it,
 * and this keeps it out of every other trial's process as well.
 */

import { VENDORS } from '@deduvafork/squad-sdk/config/vendors';
import { createAiSdkHarness, type AiSdkProvider } from '@deduvafork/squad-lab/harnesses/ai-sdk';
import { createNativeHarness } from '@deduvafork/squad-lab/harnesses/native';

import type { ArmSpec, OpenArm, OpenArmContext } from './types.js';

export type { ArmHarness, ArmTopology, ArmSpec, OpenArm, OpenArmContext } from './types.js';
export { emitsOwnLifecycle } from './types.js';

/** The model an arm resolves to, without connecting anything. */
export function resolveArmModel(spec: ArmSpec): string {
  return spec.model ?? VENDORS[spec.provider].models[spec.tier ?? 'standard'];
}

/** The loop, without the topology in front of it. */
async function openLoop(spec: ArmSpec, ctx: OpenArmContext, model: string): Promise<OpenArm> {
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

export async function openArm(spec: ArmSpec, ctx: OpenArmContext): Promise<OpenArm> {
  const model = resolveArmModel(spec);
  const loop = await openLoop(spec, ctx, model);

  if ((spec.topology ?? 'single') === 'single') return loop;

  const { createSwarmSession, DEFAULT_SWARM_AGENTS, DEFAULT_SWARM_ROUTING } = await import('./swarm.js');
  const agents = spec.agents ?? DEFAULT_SWARM_AGENTS;
  const routing = spec.routing ?? DEFAULT_SWARM_ROUTING;

  return {
    model,
    close: loop.close,
    // Built per call rather than up front: the tools are the trial's, handed
    // over at session creation, and a swarm that captured them earlier would
    // be driving a different toolset from the one the arm was configured with.
    createSession: async (config) =>
      createSwarmSession({
        bus: ctx.bus,
        provider: spec.provider,
        model,
        agents,
        routing,
        createAgentSession: loop.createSession,
        workingDirectory: config.workingDirectory ?? ctx.workingDirectory,
        tools: (config.tools ?? []) as never,
        ...(config.maxToolRounds !== undefined ? { maxToolRounds: config.maxToolRounds } : {}),
      }),
  };
}
