/**
 * The lab's command line, ahead of the server.
 *
 * `run-variant` is the M1 primitive: one goal, one vendor, one recorded run,
 * from a clean clone with nothing hand-edited.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runVariant } from './run-variant.js';
import { prepareWorkspace } from './isolate.js';
import { DEFAULT_AGENTS, DEFAULT_ROUTING } from './defaults.js';
import { createGoal, ensureRepo, gitRemote, whoami, type AdpEndpoint } from './adp.js';
import type { SquadProvider } from '@deduvafork/squad-sdk/config/vendors';

function arg(name: string, fallback?: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = hit ? hit.slice(name.length + 3) : undefined;
  if (value === undefined && fallback === undefined) {
    throw new Error(`missing required --${name}=`);
  }
  return value ?? fallback!;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Vendor credentials, which are asymmetric and quietly so.
 *
 * Anthropic inherits the `claude` CLI's own credential chain, so there is
 * nothing to pass and nothing to check. Gemini needs its key handed over
 * explicitly — and `GEMINI_API_KEY` merely being in the environment
 * deliberately does not count as choosing that vendor, so it has to be read
 * and passed rather than left to be picked up.
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

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'run-variant') {
    console.error('usage: cli.ts run-variant --seed=<path> --provider=<anthropic|gemini> [...]');
    process.exit(2);
  }

  const tokenEnv = arg('token-env', 'SQUAD_LAB_ADP_TOKEN');
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`${tokenEnv} is not set`);

  const owner = arg('owner', 'lab');
  const repo = arg('repo');
  const endpoint: AdpEndpoint = {
    baseUrl: arg('adp-url', 'http://127.0.0.1:8793'),
    token,
    owner,
    repo,
  };

  const who = await whoami(endpoint);
  console.log(`→ ADP ${endpoint.baseUrl} as ${who.login}`);

  await ensureRepo(endpoint);

  // Either reuse a goal or file one. Filing is what mints the intent.
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
    // Push to ADP, not to the seed: closing a run resolves the sha there.
    pushRemote: gitRemote(endpoint),
    adp: { url: endpoint.baseUrl, repo: `${owner}/${repo}`, tokenEnv },
  });
  console.log(`→ work repo ${workspace.workDir} on ${workspace.branch}`);

  const result = await runVariant({
    experimentId,
    variantId,
    provider,
    credentials: loadCredentials(provider),
    ...(flag('tier') ? {} : {}),
    ...(process.argv.some((a) => a.startsWith('--model=')) ? { model: arg('model') } : {}),
    adp: { ...endpoint, issueNumber, intentId, tokenEnv },
    externalRef: `${experimentId}:${variantId}`,
    workspace,
    outDir: join(root, variantId),
    agents: DEFAULT_AGENTS,
    routing: DEFAULT_ROUTING,
    ...(process.argv.some((a) => a.startsWith('--deadline-ms='))
      ? { limits: { deadlineMs: Number(arg('deadline-ms')) } }
      : {}),
    onPhase: (phase, detail) =>
      console.log(`   [${phase}]${detail ? ` ${JSON.stringify(detail)}` : ''}`),
  });

  console.log(
    `→ ${result.outcome}: run=${result.runId} sha=${result.finalSha} ` +
      `tests=${result.testPassed === null ? 'n/a' : result.testPassed ? 'pass' : 'fail'} ` +
      `quiesced=${(result.timeToQuiescenceMs / 1000).toFixed(1)}s ` +
      `wall=${(result.wallClockMs / 1000).toFixed(1)}s`,
  );
  process.exit(result.outcome === 'error' ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
