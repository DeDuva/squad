/**
 * The lab's command line, ahead of the server.
 *
 * `run-variant` is one goal on one vendor. `launch` is the experiment: the same
 * goal fanned across N vendors, all against one ADP intent, which is what makes
 * `runs/compare` a ranking rather than a pile of unrelated runs.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runVariant } from './run-variant.js';
import { prepareWorkspace } from './isolate.js';
import { DEFAULT_AGENTS, DEFAULT_ROUTING } from './defaults.js';
import { createGoal, ensureRepo, gitRemote, whoami, type AdpEndpoint } from './adp.js';
import {
  createExperiment,
  launchExperiment,
  listExperiments,
  loadExperiment,
  loadVariantStates,
  regradeVariant,
} from './experiments.js';
import type { GradeRecord } from './grader.js';
import { buildSummary, rankByAxis, UNPRICED_PROVIDERS } from './summary.js';
import type { SquadProvider } from '@deduvafork/squad-sdk/config/vendors';

function arg(name: string, fallback?: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = hit ? hit.slice(name.length + 3) : undefined;
  if (value === undefined && fallback === undefined) {
    throw new Error(`missing required --${name}=`);
  }
  return value ?? fallback!;
}

const has = (name: string) => process.argv.some((a) => a.startsWith(`--${name}=`));
const flag = (name: string) => process.argv.includes(`--${name}`);

/**
 * Vendor credentials, which are asymmetric and quietly so.
 *
 * Anthropic inherits the `claude` CLI's own credential chain, so there is
 * nothing to pass. Gemini needs its key handed over explicitly — and
 * `GEMINI_API_KEY` merely being in the environment deliberately does not count
 * as choosing that vendor, so it has to be read and passed rather than left to
 * be picked up.
 */
function loadCredentials(provider: SquadProvider): { geminiApiKey?: string } {
  if (provider !== 'gemini') return {};
  if (process.env['GEMINI_API_KEY']) return { geminiApiKey: process.env['GEMINI_API_KEY'] };
  const keyFile = join(homedir(), '.config', 'squad', 'gemini.json');
  if (existsSync(keyFile)) {
    const parsed = JSON.parse(readFileSync(keyFile, 'utf8')) as { apiKey?: string };
    if (parsed.apiKey) return { geminiApiKey: parsed.apiKey };
  }
  throw new Error(`no Gemini key: set GEMINI_API_KEY or write ${keyFile}`);
}

function endpointFromArgs(): { endpoint: AdpEndpoint; tokenEnv: string } {
  const tokenEnv = arg('token-env', 'SQUAD_LAB_ADP_TOKEN');
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`${tokenEnv} is not set`);
  return {
    tokenEnv,
    endpoint: {
      baseUrl: arg('adp-url', 'http://127.0.0.1:8793'),
      token,
      owner: arg('owner', 'lab'),
      repo: arg('repo'),
    },
  };
}

/**
 * The grader's token, which is a second principal and not a second copy.
 *
 * Held only here, never handed to a variant child and never to the grader
 * itself, so the only thing that can report a score is the lab.
 */
function evalTokenFromArgs(): string {
  const env = arg('eval-token-env', 'SQUAD_LAB_EVAL_TOKEN');
  const token = process.env[env];
  if (!token) {
    throw new Error(
      `${env} is not set — scoring needs an identity other than the one that opens runs`,
    );
  }
  return token;
}

/** `--variants=anthropic,gemini` or `anthropic:premium,gemini:fast`. */
function parseVariants(spec: string) {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [provider, tier] = s.split(':');
      return {
        provider: provider as SquadProvider,
        ...(tier ? { tier: tier as 'premium' | 'standard' | 'fast' } : {}),
      };
    });
}

async function cmdRunVariant(): Promise<number> {
  const { endpoint, tokenEnv } = endpointFromArgs();
  const who = await whoami(endpoint);
  console.log(`→ ADP ${endpoint.baseUrl} as ${who.login}`);
  await ensureRepo(endpoint);

  let issueNumber = Number(arg('issue', '0'));
  let intentId = arg('intent', '');
  if (!issueNumber || !intentId) {
    const goal = await createGoal(endpoint, arg('title'), arg('body', ''));
    issueNumber = goal.issueNumber;
    intentId = goal.intentId;
    console.log(`→ goal filed as issue #${issueNumber}, intent ${intentId}`);
  }

  const provider = arg('provider', 'anthropic') as SquadProvider;
  const experimentId = arg('experiment', `exp_${Date.now()}`);
  const variantId = arg('variant', provider);
  const root = arg('root', mkdtempSync(join(tmpdir(), 'squad-lab-')));

  const workspace = prepareWorkspace({
    workDir: join(root, variantId, 'work'),
    seedRepo: resolve(arg('seed')),
    branch: `lab/${experimentId}/${variantId}`,
    pushRemote: gitRemote(endpoint),
    adp: { url: endpoint.baseUrl, repo: `${endpoint.owner}/${endpoint.repo}`, tokenEnv },
  });
  console.log(`→ work repo ${workspace.workDir} on ${workspace.branch}`);

  const result = await runVariant({
    experimentId,
    variantId,
    provider,
    credentials: loadCredentials(provider),
    ...(has('model') ? { model: arg('model') } : {}),
    adp: { ...endpoint, issueNumber, intentId, tokenEnv },
    externalRef: `${experimentId}:${variantId}`,
    workspace,
    outDir: join(root, variantId),
    agents: DEFAULT_AGENTS,
    routing: DEFAULT_ROUTING,
    ...(has('deadline-ms') ? { limits: { deadlineMs: Number(arg('deadline-ms')) } } : {}),
    onPhase: (phase, detail) => console.log(`   [${phase}]${detail ? ` ${JSON.stringify(detail)}` : ''}`),
  });

  console.log(
    `→ ${result.outcome}: run=${result.runId} sha=${result.finalSha} ` +
      `tests=${result.testPassed === null ? 'n/a' : result.testPassed ? 'pass' : 'fail'} ` +
      `quiesced=${(result.timeToQuiescenceMs / 1000).toFixed(1)}s wall=${(result.wallClockMs / 1000).toFixed(1)}s`,
  );
  return result.outcome === 'error' ? 1 : 0;
}

async function cmdLaunch(): Promise<number> {
  const { endpoint, tokenEnv } = endpointFromArgs();
  const variants = parseVariants(arg('variants', 'anthropic,gemini'));

  const goalFile = has('goal-file') ? resolve(arg('goal-file')) : undefined;
  const [title, body] = goalFile
    ? splitGoal(readFileSync(goalFile, 'utf8'))
    : [arg('title'), arg('body', '')];

  const experiment = await createExperiment({
    goal: { title, body },
    adp: { ...endpoint, tokenEnv },
    seed: { repoUrl: resolve(arg('seed')) },
    variants,
    ...(has('grader')
      ? { grader: { path: resolve(arg('grader')), primaryAxis: arg('primary-axis', 'acceptance') } }
      : {}),
    ...(has('deadline-ms') ? { limits: { deadlineMs: Number(arg('deadline-ms')) } } : {}),
  });

  console.log(`→ experiment ${experiment.id}`);
  console.log(`   goal   : issue #${experiment.adp.issueNumber}, intent ${experiment.adp.intentId}`);
  console.log(`   variants: ${experiment.variants.map((v) => `${v.id}(${v.provider})`).join(', ')}`);

  const credentials: Record<string, { geminiApiKey?: string }> = {};
  for (const v of experiment.variants) credentials[v.id] = loadCredentials(v.provider);

  const results = await launchExperiment(experiment, {
    token: endpoint.token,
    ...(experiment.grader ? { evalToken: evalTokenFromArgs() } : {}),
    sequential: flag('sequential'),
    credentials,
    onPhase: (variantId, phase, detail) =>
      console.log(`   [${variantId}] ${phase}${detail ? ` ${JSON.stringify(detail)}` : ''}`),
    onGrade: (variantId, grade) => printGrade(variantId, grade),
  });

  for (const r of results) {
    console.log(
      `→ ${r.variantId}: ${r.outcome} run=${r.runId ?? '-'} sha=${r.finalSha?.slice(0, 12) ?? '-'} ` +
        `quiesced=${(r.timeToQuiescenceMs / 1000).toFixed(1)}s${r.error ? ` err=${r.error}` : ''}`,
    );
  }

  await printSummary(experiment.id, endpoint);
  return results.every((r) => r.outcome === 'error') ? 1 : 0;
}

async function cmdSummary(): Promise<number> {
  const { endpoint } = endpointFromArgs();
  await printSummary(arg('experiment'), endpoint);
  return 0;
}

async function cmdRegrade(): Promise<number> {
  const { endpoint } = endpointFromArgs();
  const experimentId = arg('experiment');
  const evalToken = evalTokenFromArgs();

  const exp = loadExperiment(experimentId);
  const targets = has('variant')
    ? [arg('variant')]
    : exp.variants.map((v) => v.id);

  let scored = 0;
  for (const variantId of targets) {
    const grade = await regradeVariant(experimentId, variantId, { token: endpoint.token, evalToken });
    printGrade(variantId, grade);
    if (grade.outcome === 'scored') scored += 1;
  }

  await printSummary(experimentId, endpoint);
  return scored > 0 ? 0 : 1;
}

/**
 * One line per axis, and the reason on the line when there is no score.
 *
 * An unscored variant reads as `— unscored (why)` and never as `0.00`: the two
 * mean opposite things and only one of them is a measurement.
 */
function printGrade(variantId: string, grade: GradeRecord): void {
  if (grade.outcome === 'unscored' && !grade.axes) {
    console.log(`   [${variantId}] grade: — unscored (${grade.reason ?? 'unknown'})`);
    return;
  }
  const digest = grade.specDigest ? ` digest=${grade.specDigest.slice(0, 12)}` : '';
  console.log(`   [${variantId}] grade:${digest}`);
  for (const axis of grade.axes ?? []) {
    const score = axis.score === null ? '—  not measured' : axis.score.toFixed(2);
    const auth =
      axis.separatelyAuthorized === undefined
        ? ''
        : axis.separatelyAuthorized
          ? ' separately_authorized'
          : ' SELF-REPORTED';
    console.log(
      `      ${axis.axis.padEnd(14)} ${String(score).padEnd(16)} gate=${axis.gateName}` +
        (axis.posted ? auth : ` NOT POSTED (${axis.error ?? 'unknown'})`),
    );
  }
  for (const w of grade.warnings ?? []) console.log(`      ⚠ ${w}`);
}

async function printSummary(experimentId: string, ep: AdpEndpoint): Promise<void> {
  const exp = loadExperiment(experimentId);
  const summary = await buildSummary(exp, ep);

  console.log(`\n=== ${exp.goal.title} — ${summary.rows.length} run(s) on intent ${summary.intentId}`);
  for (const row of summary.rows) {
    const unpriced = row.provider && UNPRICED_PROVIDERS.has(row.provider);
    // Never `$0.00`: an unpriced vendor is unpriced, not free, and a dollar
    // figure here would rank it first for a reason unrelated to the vendor.
    const cost = unpriced ? 'unpriced' : `$${(row.costMicroUsd / 1_000_000).toFixed(4)}`;
    // The headline counts the tools both vendors actually shared. Built-ins are
    // reported beside it, never folded in — one backend supplies its own file
    // tools and the other does not, so a combined total compares two different
    // things and looks like a tie.
    const t = row.tools;
    const tools = t
      ? `tools=${t.registeredCalls}/${t.registeredFailures}f` +
        (t.hasBuiltins ? ` (+${t.builtinCalls} built-in)` : '')
      : `tools=${row.toolCalls}/${row.toolFailures}f`;
    console.log(
      `  ${(row.variantId ?? row.runId).padEnd(18)} ${row.status.padEnd(9)} ` +
        `events=${String(row.events).padEnd(4)} ${tools.padEnd(28)} ` +
        `tokens=${row.tokensIn}in/${row.tokensOut}out cost=${cost}`,
    );
    if (t && t.registered.length > 0) {
      console.log(
        `      registered: ${t.registered.map((x) => `${x.name}×${x.count}${x.failures ? `(${x.failures}f)` : ''}`).join(' ')}`,
      );
    }
    if (t?.hasBuiltins) {
      console.log(
        `      built-in  : ${t.builtin.map((x) => `${x.name}×${x.count}${x.failures ? `(${x.failures}f)` : ''}`).join(' ')}`,
      );
    }
  }

  for (const axis of summary.axes) {
    console.log(`  --- axis: ${axis}`);
    for (const e of rankByAxis(summary, axis)) {
      console.log(
        `      ${e.variantId.padEnd(18)} ${e.score === null ? '—  not measured' : `${e.score.toFixed(2)}  #${e.rank}`}`,
      );
    }
  }

  if (summary.warnings.length > 0) {
    console.log('  --- warnings');
    for (const w of summary.warnings) console.log(`      ${JSON.stringify(w)}`);
  }
}

function splitGoal(text: string): [string, string] {
  const lines = text.split('\n');
  const title = (lines[0] ?? '').replace(/^#\s*/, '').trim();
  return [title, lines.slice(1).join('\n').trim()];
}

function cmdList(): number {
  for (const exp of listExperiments()) {
    const states = loadVariantStates(exp.id);
    console.log(
      `${exp.id}  ${exp.status.padEnd(9)} ${exp.goal.title.slice(0, 40).padEnd(42)} ` +
        states.map((s) => `${s.id}=${s.phase}`).join(' '),
    );
  }
  return 0;
}

const COMMANDS: Record<string, () => number | Promise<number>> = {
  'run-variant': cmdRunVariant,
  launch: cmdLaunch,
  regrade: cmdRegrade,
  summary: cmdSummary,
  list: cmdList,
};

async function main(): Promise<void> {
  const command = process.argv[2] ?? '';
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`usage: cli.ts <${Object.keys(COMMANDS).join('|')}> [--flags]`);
    process.exit(2);
  }
  process.exit(await handler());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
