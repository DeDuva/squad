/**
 * The two commands that touch a live ADP.
 *
 * `goal` files the issue that mints an intent; `trial` runs exactly one trial
 * against it. They are separate because an intent is per *task*, not per trial
 * — every arm and every repetition of one task hangs off the same intent, which
 * is what makes `runs/compare` a ranking rather than a pile of unrelated runs.
 *
 * `trial` is deliberately a whole process for one trial. S4 schedules studies by
 * spawning it: per-process vendor keys and cwd, a real SIGKILL when a trial
 * overruns, and no way for one trial's state to leak into its sibling's.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SquadProvider } from '@deduvafork/squad-sdk/config/vendors';
import { createGoal, ensureRepo, gitRemote, whoami, type AdpEndpoint } from '@deduvafork/squad-lab/adp';

import { runTrial, type TrialResult } from './runner.js';
import { resolveArmModel, type ArmHarness, type ArmSpec } from './arms/index.js';
import { vendorKey } from './credentials.js';

/**
 * The charter every S1 trial gets.
 *
 * The closing instruction is not politeness. This track's ceiling is single-turn
 * quiescence: the runner awaits exactly one turn, so an agent that intends to
 * keep going after it has stopped being listened to produces a trajectory that
 * ends mid-thought and a tree that may be half-written.
 */
export const DEFAULT_CHARTER =
  'You are a careful software engineer. Complete the task in the repository you have been given, ' +
  'using the tools provided. Write real files. When the task is done, stop and make no further tool calls.';

export interface CliIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
}

function arg(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function required(argv: string[], name: string): string {
  const value = arg(argv, name);
  if (value === undefined) throw new Error(`missing required --${name}=`);
  return value;
}

function endpoint(argv: string[], env: NodeJS.ProcessEnv): AdpEndpoint & { tokenEnv: string } {
  const tokenEnv = arg(argv, 'token-env') ?? 'SQUAD_LAB_ADP_TOKEN';
  const token = env[tokenEnv];
  if (!token) throw new Error(`no ADP token in ${tokenEnv}`);
  return {
    baseUrl: required(argv, 'adp-url'),
    token,
    owner: required(argv, 'owner'),
    repo: required(argv, 'repo'),
    tokenEnv,
  };
}

/** `--arm=squad-native:anthropic` or `--arm=ai-sdk:gemini`. */
export function parseArm(value: string, tier?: string): ArmSpec {
  const [harness, provider] = value.split(':');
  if (harness !== 'squad-native' && harness !== 'ai-sdk' && harness !== 'swarm') {
    throw new Error(`unknown harness '${harness}' — expected squad-native, ai-sdk or swarm`);
  }
  if (provider !== 'anthropic' && provider !== 'gemini') {
    throw new Error(`unknown provider '${provider}' — expected anthropic or gemini`);
  }
  return {
    id: value,
    harness: harness as ArmHarness,
    provider: provider as SquadProvider,
    ...(tier ? { tier: tier as ArmSpec['tier'] } : {}),
  };
}

/** File the goal, which is what mints the intent every run hangs off. */
export async function mintGoal({ argv, env }: CliIo): Promise<string> {
  const ep = endpoint(argv, env);
  const who = await whoami(ep);
  await ensureRepo(ep);
  const goal = await createGoal(ep, required(argv, 'title'), arg(argv, 'body') ?? '');
  return (
    `${JSON.stringify({ ...goal, actor: who.login, gitRemote: gitRemote(ep) }, null, 2)}\n`
  );
}

export async function runTrialCommand({ argv, env }: CliIo): Promise<{ result: TrialResult; report: string }> {
  const ep = endpoint(argv, env);
  const arm = parseArm(required(argv, 'arm'), arg(argv, 'tier') ?? 'fast');
  const issueNumber = Number(required(argv, 'issue'));
  const externalRef = required(argv, 'external-ref');
  const outDir = arg(argv, 'out') ?? mkdtempSync(join(tmpdir(), 'duva-bench-trial-'));
  const workDir = arg(argv, 'work-dir') ?? join(outDir, 'work');
  const key = vendorKey(arm.provider, env);

  const result = await runTrial({
    externalRef,
    arm,
    adp: { ...ep, issueNumber, intentId: required(argv, 'intent') },
    workspace: {
      workDir,
      seedRepo: required(argv, 'seed'),
      branch: `trial/${externalRef.replace(/[^a-zA-Z0-9._-]/g, '-')}`,
      // A trial must push to ADP, not to the seed: closing a run resolves the
      // sha *in ADP's repository*, so a commit pushed anywhere else produces a
      // run that cannot be closed against it.
      pushRemote: gitRemote(ep),
    },
    agent: { name: arg(argv, 'agent') ?? 'solver', prompt: arg(argv, 'charter') ?? DEFAULT_CHARTER },
    // What this trial was, said once at open, where ADP signs it into the run
    // predicate. `platform` is what lets the squad and Harbor tracks share one
    // record and still be told apart.
    labels: {
      platform: 'squad',
      arm: arm.id,
      harness: arm.harness,
      provider: arm.provider,
      model: resolveArmModel(arm),
      ...(arm.tier ? { tier: arm.tier } : {}),
    },
    outDir,
    ...(key ? { apiKey: key } : {}),
    ...(arg(argv, 'deadline-ms') ? { limits: { deadlineMs: Number(arg(argv, 'deadline-ms')) } } : {}),
    onPhase: (phase, detail) => {
      if (process.env.DUVA_BENCH_QUIET) return;
      process.stderr.write(`  ${phase}${detail ? ` ${JSON.stringify(detail)}` : ''}\n`);
    },
  });

  return { result, report: `${JSON.stringify(result, null, 2)}\n` };
}
