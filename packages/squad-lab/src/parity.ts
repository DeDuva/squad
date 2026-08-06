/**
 * What the wire actually does, per provider.
 *
 * `conformance.ts` checks a harness's *bookkeeping* — does it report tool
 * calls, does it keep the budget it was given. This checks the layer under
 * that: whether the tool schema a provider was handed survives the trip, and
 * whether the tool exchange behaves the same way on both sides of a comparison.
 *
 * The distinction that took three invalidated experiments to learn: **parity is
 * not "every provider supports X". It is "the providers in this experiment
 * agree about X".** A capability neither vendor has costs nothing; a capability
 * one has and the other lacks is a difference that will be reported as a model
 * difference. So this produces a *profile* per provider and compares profiles,
 * exactly as `spec_digest` compares rubrics — the same idea one layer down.
 *
 * The three we have already paid for:
 *  - one backend's built-in tools, read as a 72x efficiency gap
 *  - one backend's ten-round ceiling, read as a model that gave up
 *  - and the one this file exists to catch first: Gemini returns a
 *    `thought_signature` with a function call that must be sent back on the
 *    next turn. A layer that drops it degrades multi-turn tool use, and the
 *    degradation looks exactly like a weaker model.
 */

import type { ConformanceContext, ConformanceTool } from './conformance.js';

/** What a provider did when handed a particular kind of schema or exchange. */
export type ProbeOutcome = 'honoured' | 'violated' | 'unsupported' | 'errored';

export interface WireProfile {
  provider: string;
  /** A tool whose arguments are a nested object with a required inner field. */
  nestedSchema: ProbeOutcome;
  /** A parameter constrained by `enum`. */
  enumConstraint: ProbeOutcome;
  /** Two independent tools offered at once — did any single round call both? */
  parallelToolCalls: boolean;
  /** A second tool call that depends on the first one's result. */
  multiTurnToolChain: ProbeOutcome;
  /** A tool that rejects its input: recovered, or gave up? */
  invalidArgumentRecovery: ProbeOutcome;
  /** Free-text notes worth reading beside the table. */
  notes: string[];
}

export interface ParityWarning {
  kind: 'capability_mismatch' | 'schema_mismatch';
  property: keyof WireProfile;
  values: Record<string, string>;
  message: string;
}

const record = (tool: ConformanceTool, seen: string[]): ConformanceTool => ({
  ...tool,
  handler: async (args) => {
    seen.push(JSON.stringify(args ?? {}));
    return tool.handler(args);
  },
});

/**
 * Drive one provider through the exchanges that differ between providers.
 *
 * Every probe is a real turn against a real model, so this costs a handful of
 * cheap calls per provider. That is the point: the failures it looks for are
 * invisible in documentation and only appear on the wire.
 */
export async function probeWireParity(provider: string, ctx: ConformanceContext): Promise<WireProfile> {
  const notes: string[] = [];
  const profile: WireProfile = {
    provider,
    nestedSchema: 'errored',
    enumConstraint: 'errored',
    parallelToolCalls: false,
    multiTurnToolChain: 'errored',
    invalidArgumentRecovery: 'errored',
    notes,
  };

  // --- nested object + enum, in one tool -----------------------------------
  {
    const seen: string[] = [];
    const tool: ConformanceTool = {
      name: 'file_report',
      description: 'Report a file. Call it exactly once.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'object',
            description: 'Which file, and how to treat it',
            properties: {
              path: { type: 'string', description: 'repo-relative path' },
              mode: { type: 'string', enum: ['read', 'write', 'append'] },
            },
            required: ['path', 'mode'],
          },
        },
        required: ['target'],
      },
      handler: async () => 'recorded',
    };

    try {
      const session = await ctx.createSession({
        agentName: 'Prober',
        tools: [record(tool, seen)],
        systemMessage: {
          mode: 'replace',
          content:
            'Call file_report exactly once for the file "src/index.js", opening it to read. Then reply with one word.',
        },
        maxToolRounds: 4,
      });
      await session.sendAndWait?.({ prompt: 'Report src/index.js, mode read.' }, 60_000);

      const args = seen.map((s) => JSON.parse(s) as Record<string, unknown>);
      const nested = args.find((a) => a['target'] && typeof a['target'] === 'object');
      if (!nested) {
        // Flattening is the failure that matters: a provider that turns
        // {target:{path,mode}} into {path,mode} has been handed a different
        // contract from the one the other provider got.
        profile.nestedSchema = args.length > 0 ? 'violated' : 'errored';
        if (args.length > 0) notes.push(`nested object flattened to ${JSON.stringify(args[0])}`);
      } else {
        const target = nested['target'] as Record<string, unknown>;
        profile.nestedSchema = typeof target['path'] === 'string' ? 'honoured' : 'violated';
        profile.enumConstraint = ['read', 'write', 'append'].includes(String(target['mode']))
          ? 'honoured'
          : 'violated';
        if (profile.enumConstraint === 'violated') notes.push(`enum produced ${JSON.stringify(target['mode'])}`);
      }
    } catch (err) {
      notes.push(`nested/enum probe threw: ${(err as Error).message}`);
    }
  }

  // --- parallel tool calls -------------------------------------------------
  {
    const rounds: string[][] = [];
    let current: string[] = [];
    let timer: NodeJS.Timeout | undefined;
    const note = (name: string) => {
      current.push(name);
      clearTimeout(timer);
      // Calls raised together arrive within a few milliseconds of each other;
      // a dependent second call arrives after a model round trip.
      timer = setTimeout(() => {
        rounds.push([...current]);
        current = [];
      }, 250);
    };

    const mk = (name: string): ConformanceTool => ({
      name,
      description: `Returns the ${name} of the project.`,
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        note(name);
        return `${name}: ok`;
      },
    });

    try {
      const session = await ctx.createSession({
        agentName: 'Prober',
        tools: [mk('get_version'), mk('get_licence')],
        systemMessage: {
          mode: 'replace',
          content: 'Call both get_version and get_licence, then reply with one word.',
        },
        maxToolRounds: 6,
      });
      await session.sendAndWait?.({ prompt: 'Get the version and the licence.' }, 60_000);
      await new Promise((r) => setTimeout(r, 400));
      profile.parallelToolCalls = rounds.some((r) => r.length > 1);
      notes.push(`tool rounds: ${JSON.stringify(rounds)}`);
    } catch (err) {
      notes.push(`parallel probe threw: ${(err as Error).message}`);
    }
  }

  // --- a chained exchange: the thought-signature case ----------------------
  {
    const order: string[] = [];
    const lookup: ConformanceTool = {
      name: 'lookup_id',
      description: 'Returns the id for a name. Call this first.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      handler: async () => {
        order.push('lookup_id');
        return 'the id is 4417';
      },
    };
    const submit: ConformanceTool = {
      name: 'submit_id',
      description: 'Submits an id obtained from lookup_id. Call this second, with that id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: async (args) => {
        order.push(`submit_id:${String((args as { id?: unknown }).id ?? '')}`);
        return 'submitted';
      },
    };

    try {
      const session = await ctx.createSession({
        agentName: 'Prober',
        tools: [lookup, submit],
        systemMessage: {
          mode: 'replace',
          content:
            'First call lookup_id for the name "widget". Then call submit_id with the id it returned. Then reply with one word.',
        },
        maxToolRounds: 8,
      });
      await session.sendAndWait?.({ prompt: 'Look up "widget" and submit its id.' }, 90_000);

      const submitted = order.find((o) => o.startsWith('submit_id:'));
      // The whole multi-turn story in one assertion: a tool result has to be
      // carried back well enough for the model to act on its *contents*. This
      // is what a dropped `thought_signature` breaks, and it breaks quietly.
      profile.multiTurnToolChain = !submitted
        ? 'violated'
        : submitted.includes('4417')
          ? 'honoured'
          : 'violated';
      notes.push(`chain: ${JSON.stringify(order)}`);
    } catch (err) {
      notes.push(`chain probe threw: ${(err as Error).message}`);
    }
  }

  // --- a tool that rejects its input --------------------------------------
  {
    let attempts = 0;
    const picky: ConformanceTool = {
      name: 'set_level',
      description: 'Sets the level. `level` must be one of: low, medium, high.',
      parameters: {
        type: 'object',
        properties: { level: { type: 'string', enum: ['low', 'medium', 'high'] } },
        required: ['level'],
      },
      handler: async (args) => {
        attempts += 1;
        const level = String((args as { level?: unknown }).level ?? '');
        if (attempts === 1) throw new Error(`'${level}' is not valid; use low, medium or high`);
        return `level set to ${level}`;
      },
    };

    try {
      const session = await ctx.createSession({
        agentName: 'Prober',
        tools: [picky],
        systemMessage: {
          mode: 'replace',
          content:
            'Call set_level to put the level as high as it goes. If the tool rejects your call, read the error and call it again correctly. Then reply with one word.',
        },
        maxToolRounds: 6,
      });
      await session.sendAndWait?.({ prompt: 'Set the level to the maximum.' }, 90_000);
      // Recovering from a rejected call is a real capability difference: a
      // provider that gives up on the first error scores worse on any task
      // with a fussy tool, for reasons that are not about its reasoning.
      profile.invalidArgumentRecovery = attempts >= 2 ? 'honoured' : attempts === 1 ? 'violated' : 'errored';
      notes.push(`set_level attempts: ${attempts}`);
    } catch (err) {
      notes.push(`recovery probe threw: ${(err as Error).message}`);
    }
  }

  return profile;
}

/**
 * Where two providers disagree.
 *
 * A property both providers lack is not a warning — it costs neither of them.
 * Only a *difference* invalidates a comparison, which is why this compares
 * profiles rather than checking each against an ideal.
 */
export function compareProfiles(profiles: WireProfile[]): ParityWarning[] {
  if (profiles.length < 2) return [];
  const warnings: ParityWarning[] = [];

  const properties: (keyof WireProfile)[] = [
    'nestedSchema',
    'enumConstraint',
    'parallelToolCalls',
    'multiTurnToolChain',
    'invalidArgumentRecovery',
  ];

  for (const property of properties) {
    const values: Record<string, string> = {};
    for (const p of profiles) values[p.provider] = String(p[property]);
    if (new Set(Object.values(values)).size <= 1) continue;

    warnings.push({
      kind: property === 'parallelToolCalls' ? 'capability_mismatch' : 'schema_mismatch',
      property,
      values,
      message:
        `providers disagree on ${property} (${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(', ')}) — ` +
        'a difference here shows up as a difference between models',
    });
  }

  return warnings;
}

export function formatProfiles(profiles: WireProfile[]): string {
  const lines: string[] = [];
  for (const p of profiles) {
    lines.push(`  ${p.provider}`);
    lines.push(`    nested schema        ${p.nestedSchema}`);
    lines.push(`    enum constraint      ${p.enumConstraint}`);
    lines.push(`    parallel tool calls  ${p.parallelToolCalls}`);
    lines.push(`    multi-turn chain     ${p.multiTurnToolChain}`);
    lines.push(`    invalid-arg recovery ${p.invalidArgumentRecovery}`);
    for (const n of p.notes) lines.push(`    · ${n}`);
  }
  const warnings = compareProfiles(profiles);
  if (warnings.length === 0 && profiles.length > 1) {
    lines.push('  the providers agree on every probed property');
  }
  for (const w of warnings) lines.push(`  WARN ${w.message}`);
  return lines.join('\n');
}
