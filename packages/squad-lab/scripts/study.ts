/**
 * A factorial study: tasks x models x harnesses, repeated.
 *
 * The lab's `launch` command answers "which of these is better on this task
 * once". That question has no answer without a noise floor, because a single
 * pair of runs differing by 0.1 and a single pair differing by 0.1 for no
 * reason at all look exactly alike. This runs the same cell `--repeats` times
 * so the floor is measured rather than assumed, and every other contrast is
 * read against it.
 *
 * One ADP intent per task, every run of that task against it, so
 * `runs/compare` stays the join it already is.
 *
 *   SQUAD_LAB_ADP_TOKEN=… SQUAD_LAB_EVAL_TOKEN=… \
 *     npm run study -w @deduvafork/squad-lab -- \
 *       --tasks=csvparse --repeats=5 --concurrency=6
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createExperiment, launchExperiment } from '../src/experiments.js';
import type { HarnessImpl } from '../src/harness.js';
import type { SquadProvider } from '@deduvafork/squad-sdk/config/vendors';

const here = dirname(fileURLToPath(import.meta.url));
const examples = resolve(here, '..', 'examples');

/**
 * The model axis.
 *
 * Two tiers per vendor, so "model" is not a synonym for "vendor". A study with
 * one model each could only ever report a vendor difference, and would report
 * it whether or not that is what it found.
 */
export const MODELS: { key: string; provider: SquadProvider; model: string }[] = [
  { key: 'haiku', provider: 'anthropic', model: 'claude-haiku-4-5' },
  { key: 'sonnet', provider: 'anthropic', model: 'claude-sonnet-5' },
  { key: 'flash', provider: 'gemini', model: 'gemini-flash-latest' },
  { key: 'pro', provider: 'gemini', model: 'gemini-pro-latest' },
];

export const HARNESSES: HarnessImpl[] = ['squad-native', 'ai-sdk'];

const arg = (name: string, fallback?: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = hit ? hit.slice(name.length + 3) : undefined;
  if (value === undefined && fallback === undefined) throw new Error(`missing required --${name}=`);
  return value ?? fallback!;
};

/** Materialise a task's seed as a real git repository, which is what the lab clones. */
function buildSeed(task: string, root: string): string {
  const target = join(root, `${task}-seed`);
  execFileSync('node', [join(examples, task, 'make-seed.mjs'), target], { encoding: 'utf8' });
  return target;
}

function splitGoal(text: string): [string, string] {
  const lines = text.split('\n');
  const title = (lines[0] ?? '').replace(/^#\s*/, '').trim();
  return [title, lines.slice(1).join('\n').trim()];
}

async function main(): Promise<void> {
  const tasks = arg('tasks', 'csvparse').split(',').map((s) => s.trim()).filter(Boolean);
  const repeats = Number(arg('repeats', '5'));
  const concurrency = Number(arg('concurrency', '6'));
  const deadlineMs = Number(arg('deadline-ms', '600000'));
  const maxToolRounds = Number(arg('max-tool-rounds', '25'));
  const modelKeys = arg('models', MODELS.map((m) => m.key).join(',')).split(',');
  const models = MODELS.filter((m) => modelKeys.includes(m.key));
  const harnesses = arg('harnesses', HARNESSES.join(',')).split(',') as HarnessImpl[];

  const token = process.env['SQUAD_LAB_ADP_TOKEN'];
  const evalToken = process.env['SQUAD_LAB_EVAL_TOKEN'];
  if (!token) throw new Error('SQUAD_LAB_ADP_TOKEN is not set');
  if (!evalToken) throw new Error('SQUAD_LAB_EVAL_TOKEN is not set — a study that cannot score is not a study');

  const baseUrl = arg('adp-url', 'http://127.0.0.1:8793');
  const owner = arg('owner', 'lab');
  const root = arg('root', join(process.env['SQUAD_LAB_HOME'] ?? '/tmp', 'study'));
  mkdirSync(root, { recursive: true });

  // Every vendor key up front. A study is long enough that discovering a
  // missing credential in hour two is its own kind of failure.
  const credentials: Record<string, { geminiApiKey?: string; anthropicApiKey?: string }> = {};
  for (const provider of new Set(models.map((m) => m.provider))) {
    const key = process.env[provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'];
    if (!key) throw new Error(`no key for ${provider} — export its API key before starting`);
    credentials[provider] = provider === 'gemini' ? { geminiApiKey: key } : { anthropicApiKey: key };
  }

  const cells = models.length * harnesses.length;
  console.log(`study: ${tasks.length} task(s) x ${cells} cell(s) x ${repeats} repeat(s) = ${tasks.length * cells * repeats} runs`);
  console.log(`  models    : ${models.map((m) => `${m.key}(${m.model})`).join(', ')}`);
  console.log(`  harnesses : ${harnesses.join(', ')}`);
  console.log(`  concurrency: ${concurrency}`);
  console.log(`  rounds    : ${maxToolRounds} per agent`);

  const manifest: { startedAt: string; repeats: number; experiments: { task: string; id: string; intentId: string; repo: string }[] } = {
    startedAt: new Date().toISOString(),
    repeats,
    experiments: [],
  };
  const manifestPath = join(root, `manifest-${Date.now().toString(36)}.json`);

  for (const task of tasks) {
    const { readFileSync } = await import('node:fs');
    const [title, body] = splitGoal(readFileSync(join(examples, task, 'goal.md'), 'utf8'));
    const seed = buildSeed(task, root);
    const repo = `${task}-${Date.now().toString(36)}`;

    // Every cell of the factorial, named so the analysis never has to parse a
    // free-text id: `<model>-<harness>-r<n>`.
    const variants = [];
    for (const m of models) {
      for (const h of harnesses) {
        for (let r = 1; r <= repeats; r += 1) {
          variants.push({ id: `${m.key}-${h}-r${r}`, provider: m.provider, model: m.model, harnessImpl: h });
        }
      }
    }

    console.log(`\n=== ${task}: ${variants.length} runs`);
    const experiment = await createExperiment({
      goal: { title, body },
      adp: { baseUrl, token, owner, repo, tokenEnv: 'SQUAD_LAB_ADP_TOKEN' },
      seed: { repoUrl: seed },
      variants,
      grader: { path: join(examples, task, 'grader.mjs'), primaryAxis: 'acceptance' },
      limits: { deadlineMs },
      // Held constant across the whole study, so the only things varying are
      // the three axes named above. The round ceiling is the dominant cost
      // driver — every round resends the conversation, so tokens grow with the
      // square of the loop — and it must be fixed before the first cell rather
      // than tuned between them.
      harness: { toolSurface: 'registered', systemPrompt: 'charter-only', maxToolRounds },
    });

    manifest.experiments.push({ task, id: experiment.id, intentId: experiment.adp.intentId, repo });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`  experiment ${experiment.id}  intent ${experiment.adp.intentId}`);

    let done = 0;
    const started = Date.now();
    const results = await launchExperiment(experiment, {
      token,
      evalToken,
      credentials,
      maxConcurrency: concurrency,
      onPhase: (variantId, phase) => {
        if (phase !== 'done' && phase !== 'error') return;
        done += 1;
        const mins = ((Date.now() - started) / 60_000).toFixed(1);
        console.log(`  [${String(done).padStart(3)}/${variants.length}] ${variantId} ${phase} (${mins}m)`);
      },
    });

    const bad = results.filter((r) => r.outcome === 'error');
    console.log(`  ${task}: ${results.length - bad.length} ok, ${bad.length} error in ${((Date.now() - started) / 60_000).toFixed(1)}m`);
    for (const r of bad.slice(0, 6)) console.log(`    ! ${r.variantId}: ${r.error}`);
  }

  console.log(`\nmanifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
