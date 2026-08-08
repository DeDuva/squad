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
import { readFileSync } from 'node:fs';

import { loadStudyFile, resolveFrom } from './study-file.js';
import { runStudy } from './scheduler.js';
import { armDigest, shortDigest, studyDigest, type Arm, type DocsGrade } from './study.js';

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

/**
 * Resolve the arm from a study spec rather than from flags.
 *
 * This is the form S4 schedules: the arm is a cell of a digested study, so the
 * run carries the digests that say which experiment it belongs to. Attaching
 * them as labels rather than parsing them back out of `external_ref` matters
 * because ADP signs labels into the run predicate, and `external_ref` is
 * already the idempotency key — a field that must change whenever a trial is
 * re-run cannot also be the field that identifies the study.
 */
function fromStudy(
  studyPath: string,
  armId: string,
  taskId: string,
  rep: number,
): {
  arm: ArmSpec;
  labels: Record<string, string>;
  externalRef: string;
  toolset: { twinSeed?: string; docsGrade: DocsGrade };
} {
  const loaded = loadStudyFile(studyPath);
  if (!loaded.ok) {
    throw new Error(
      `study ${studyPath} is not valid:\n` +
        loaded.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'),
    );
  }
  const study = loaded.study;
  const found: Arm | undefined = study.arms.find((a) => a.id === armId);
  if (!found) {
    throw new Error(`no arm '${armId}' in ${studyPath} — have ${study.arms.map((a) => a.id).join(', ')}`);
  }
  if (!study.tasks.some((t) => t.id === taskId)) {
    throw new Error(`no task '${taskId}' in ${studyPath} — have ${study.tasks.map((t) => t.id).join(', ')}`);
  }
  const arm: ArmSpec = {
    id: found.id,
    harness: found.harness,
    topology: found.topology,
    provider: found.model.provider,
    ...(found.model.tier ? { tier: found.model.tier } : {}),
    ...(found.model.model ? { model: found.model.model } : {}),
  };
  const digest = studyDigest(study);

  return {
    arm,
    labels: {
      study: shortDigest(digest),
      study_digest: digest,
      arm_digest: armDigest(found),
      task: taskId,
      topology: found.topology,
      toolset: `${found.toolset.name}/${found.toolset.docsGrade}`,
      docs_grade: found.toolset.docsGrade,
      // `twinned` rather than the seed itself: the seed is in the arm digest
      // already, and a label a reader can scan tells them which condition a
      // run was in without resolving anything.
      twinned: found.toolset.twinSeed === undefined ? 'no' : 'yes',
    },
    externalRef: `${shortDigest(digest)}:${found.id}:${taskId}:r${rep}`,
    toolset: {
      ...(found.toolset.twinSeed !== undefined ? { twinSeed: found.toolset.twinSeed } : {}),
      docsGrade: found.toolset.docsGrade,
    },
  };
}

/**
 * Run a whole study: plan, fan out, resume, report.
 *
 * `resolveTask` reads each task's goal from disk — first line the title, the
 * rest the body — and hands over its seed path. The seed must already be a git
 * repository, because that is what a trial clones; the examples ship a
 * `make-seed.mjs` that materialises one.
 */
export async function runStudyCommand({ argv, env }: CliIo): Promise<{ report: string; code: number }> {
  const ep = endpoint(argv, env);
  const specPath = required(argv, 'file');
  const loaded = loadStudyFile(specPath);
  if (!loaded.ok) {
    throw new Error(
      `study ${specPath} is not valid:\n` + loaded.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'),
    );
  }

  const root = arg(argv, 'root') ?? mkdtempSync(join(tmpdir(), 'duva-bench-study-'));
  const result = await runStudy({
    study: loaded.study,
    ep,
    root,
    resolveTask: (task) => {
      const text = readFileSync(resolveFrom(specPath, task.goal), 'utf8');
      const lines = text.split('\n');
      return {
        title: (lines[0] ?? '').replace(/^#\s*/, '').trim(),
        body: lines.slice(1).join('\n').trim(),
        seed: resolveFrom(specPath, task.seed),
      };
    },
    onEvent: (event) => {
      if (env.DUVA_BENCH_QUIET) return;
      process.stderr.write(`  ${event.kind} ${JSON.stringify(event)}\n`);
    },
  });

  const lines = [
    `study    ${result.studyDigest}`,
    `planned  ${result.planned}   skipped ${result.skipped}   ran ${result.ran}   failed ${result.failed}`,
    `spend    $${result.spend.usd.toFixed(4)}${result.spend.unpriced > 0 ? `  (+${result.spend.unpriced} unpriced)` : ''}`,
    result.budgetStopped ? 'budget   STOPPED — the cap was reached before every trial ran' : `budget   within cap`,
    '',
    // Bands, never one ordering: trials that did not run the same program are
    // not rankable against each other, whatever their scores say.
    `bands    ${result.bands.length}${result.bands.length > 1 ? ' — this study must not be ranked as a whole' : ''}`,
  ];
  for (const band of result.bands) {
    lines.push(`  ${band.harness}/${band.topology}  arms=[${band.armIds.join(', ')}]  trials=${band.trials}`);
  }
  lines.push('', `root     ${root}`);

  return { report: `${lines.join('\n')}\n`, code: result.failed === 0 ? 0 : 1 };
}

export async function runTrialCommand({ argv, env }: CliIo): Promise<{ result: TrialResult; report: string }> {
  const ep = endpoint(argv, env);
  const studyPath = arg(argv, 'study');
  const fromSpec = studyPath
    ? fromStudy(studyPath, required(argv, 'arm'), required(argv, 'task'), Number(arg(argv, 'rep') ?? '1'))
    : undefined;

  const arm = fromSpec?.arm ?? parseArm(required(argv, 'arm'), arg(argv, 'tier') ?? 'fast');
  const issueNumber = Number(required(argv, 'issue'));
  const externalRef = arg(argv, 'external-ref') ?? fromSpec?.externalRef;
  if (!externalRef) throw new Error('missing required --external-ref= (or pass --study= and --task=)');
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
      ...(fromSpec?.labels ?? {}),
    },
    outDir,
    ...(fromSpec ? { toolset: fromSpec.toolset } : {}),
    ...(key ? { apiKey: key } : {}),
    ...(arg(argv, 'deadline-ms') ? { limits: { deadlineMs: Number(arg(argv, 'deadline-ms')) } } : {}),
    onPhase: (phase, detail) => {
      if (process.env.DUVA_BENCH_QUIET) return;
      process.stderr.write(`  ${phase}${detail ? ` ${JSON.stringify(detail)}` : ''}\n`);
    },
  });

  return { result, report: `${JSON.stringify(result, null, 2)}\n` };
}
