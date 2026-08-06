/**
 * The SPA, driven in a real browser against a real ADP.
 *
 * M6's own check: `/new` → live board → summary → drill-down. A component test
 * would assert that the React tree renders; this asserts that a person can set
 * a goal, watch it, and reach the evidence under a score — which is the thing
 * that was actually built.
 *
 * No model is invoked. Two runs are opened, labelled, closed and graded
 * directly, exactly as `live-grade-check` does, so the summary the browser
 * loads is real data with a real disagreement in it.
 *
 *   SQUAD_LAB_ADP_TOKEN=… SQUAD_LAB_EVAL_TOKEN=… \
 *     npm run ui-check -w @deduvafork/squad-lab
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

import { gitRemote, type AdpEndpoint } from '../src/adp.js';
import { gradeVariant } from '../src/grader.js';
import { startLabServer } from '../src/server.js';

const ADP_URL = process.env['ADP_URL'] ?? 'http://127.0.0.1:8793';
/** Where the walk leaves its screenshots. Evidence a person can look at. */
const SHOTS = process.env['UI_CHECK_SHOTS'] ?? join(tmpdir(), 'squad-lab-ui');
const REPO = process.env['ADP_REPO'] ?? `uicheck-${Date.now().toString(36)}`;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * A grader that reproduces the bake-off's actual result: both variants perfect
 * on the delivered module, opposite on the repository's own suite. That is the
 * case the summary exists to surface, so it is the case the browser sees.
 */
const GRADER = `
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
const repo = resolve(process.argv[2]);
const selfTests = existsSync(join(repo, 'duration.test.js'));
console.log(JSON.stringify({
  spec: { suite: 'duration-acceptance', cases: 19, visibility: 'hidden from the agents' },
  axes: {
    acceptance: { score: 1, passed: true, summary: 'hidden suite: 19/19',
                  metrics: { passed: 19, total: 19 } },
    'self-tests': { score: selfTests ? 1 : 0, passed: selfTests,
                    summary: selfTests ? "repo's own suite passed" : "repo's own suite failed",
                    metrics: { present: selfTests } },
  },
}));
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'credential.helper=', ...args], { cwd, encoding: 'utf8' }).trim();
}

function seedWorkRepo(dir: string, remote: string, branch: string, withTests: boolean): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'lab@example.invalid');
  git(dir, 'config', 'user.name', 'squad-lab');
  writeFileSync(join(dir, 'duration.js'), 'module.exports = function parseDuration() { return null; };\n');
  if (withTests) writeFileSync(join(dir, 'duration.test.js'), '// the run wrote its own tests\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'deliver the module');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  return git(dir, 'rev-parse', 'HEAD');
}

async function adp<T>(ep: AdpEndpoint, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ep.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ep.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lab-ui-'));
  process.env['SQUAD_LAB_HOME'] = join(root, 'home');
  const graderPath = join(root, 'grader.mjs');
  writeFileSync(graderPath, GRADER);
  const graderSha256 = execFileSync('sha256sum', [graderPath], { encoding: 'utf8' }).split(' ')[0]!;

  const runnerToken = required('SQUAD_LAB_ADP_TOKEN');
  const evalToken = required('SQUAD_LAB_EVAL_TOKEN');
  const lab = await startLabServer({ token: runnerToken, evalToken, adpUrl: ADP_URL, port: 0 });
  console.log(`lab on ${lab.url} · ADP ${ADP_URL} · repo lab/${REPO}`);

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page: Page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    // --- /new: set a goal ---------------------------------------------------
    await page.goto(`${lab.url}/app/new`);
    await page.getByTestId('goal-title').fill('Parse a duration string');
    await page.getByTestId('goal-body').fill('Export parseDuration(input) returning seconds, or null.');
    await page.getByTestId('repo').fill(REPO);
    await page.getByTestId('seed').fill(seedRepoFor(root));
    await page.getByTestId('grader').fill(graderPath);
    await page.getByTestId('create').click();

    await page.waitForURL(/\/app\/e\/exp_/, { timeout: 20_000 });
    const experimentId = page.url().split('/e/')[1]!;
    check('/new created an experiment and landed on its board', Boolean(experimentId), experimentId);

    // --- the live board -----------------------------------------------------
    await page.waitForSelector('[data-testid^="lane-"]');
    await shoot(page, 'board');
    const lanes = await page.locator('[data-testid^="lane-"]').count();
    check('the board shows one lane per variant', lanes === 2, lanes);
    check('the board reports the stream is live', (await page.locator('.live').count()) > 0);

    // --- real runs, real scores, no model -----------------------------------
    const runner: AdpEndpoint = { baseUrl: ADP_URL, token: runnerToken, owner: 'lab', repo: REPO };
    const grader: AdpEndpoint = { ...runner, token: evalToken };
    // The ids and refs the lab actually minted, not ones guessed here: the
    // picker appends the tier, so a variant is `anthropic-standard`. Opening a
    // run under a ref the experiment does not know would leave the summary
    // reporting, correctly, that those variants produced no run.
    const record = (await (await fetch(`${lab.url}/api/experiments/${experimentId}`)).json()).experiment as {
      adp: { intentId: string };
      variants: { id: string; provider: string; externalRef: string }[];
    };
    const intentId = record.adp.intentId;
    const MODELS: Record<string, string> = {
      anthropic: 'claude-sonnet-5',
      gemini: 'gemini-flash-latest',
    };

    for (const plan of record.variants) {
      const variantId = plan.id;
      const model = MODELS[plan.provider]!;
      // One variant ships tests and the other does not, so the two axes
      // disagree — the case the summary exists to surface.
      const withTests = plan.provider === 'gemini';
      const workRepo = join(root, variantId, 'work');
      const sha = seedWorkRepo(workRepo, gitRemote(runner), `lab/${variantId}`, withTests);
      const run = await adp<{ id: string }>(runner, 'POST', `/api/adp/repos/lab/${REPO}/runs`, {
        intent_id: intentId,
        orchestrator: 'squad',
        external_ref: plan.externalRef,
        labels: { provider: plan.provider, model, variant: variantId },
      });
      await adp(runner, 'POST', `/api/adp/repos/lab/${REPO}/runs/${run.id}/close`, { final_git_sha: sha });
      const grade = await gradeVariant({
        graderPath,
        graderSha256,
        primaryAxis: 'acceptance',
        workRepo,
        runId: run.id,
        outDir: join(root, variantId),
        gitSha: sha,
        evalEndpoint: grader,
      });
      check(`${variantId}: scored`, grade.outcome === 'scored');
    }

    // --- the exec summary ---------------------------------------------------
    await page.goto(`${lab.url}/app/e/${experimentId}/summary`);
    await page.waitForSelector('table.summary');
    const summaryText = await page.locator('section').innerText();

    check('the summary shows a column per axis', /acceptance/.test(summaryText) && /self-tests/.test(summaryText));
    check('every axis header prints its rubric digest', (await page.locator('.digest').count()) >= 2);
    // The whole reason the product exists, as a first-class state.
    check('the disagreement banner fires', (await page.getByTestId('disagreement').count()) === 1);
    // No blending, ever.
    check('the word "overall" appears nowhere', !/overall/i.test(summaryText));
    check('per-axis ranks are shown', (await page.locator('.rank').count()) >= 2);
    // Gemini is unpriced by design; $0.00 would rank it first for the wrong reason.
    check('an unpriced vendor reads "unpriced", never $0.00', /unpriced/.test(summaryText) && !/\$0\.0000/.test(summaryText));
    await shoot(page, 'summary');

    // --- drill-down ---------------------------------------------------------
    const geminiVariant = record.variants.find((v) => v.provider === 'gemini')!.id;
    await page.locator(`[data-testid="row-${geminiVariant}"] a`).first().click();
    await page.waitForURL(new RegExp(`/v/${geminiVariant}$`));
    await page.waitForSelector('[data-testid="axis-acceptance"]');
    const variantText = await page.locator('section').innerText();
    check('a score drills through to its axis cards', /acceptance/.test(variantText));
    check('and shows the score was separately authorized', /separately authorized/.test(variantText));
    check('and the labels the run was opened with', /gemini-flash-latest/.test(variantText));
    check('and the trajectory beneath it', /Trajectory/.test(variantText));
    await shoot(page, 'variant');

    await page.goto(`${lab.url}/app/e/${experimentId}/v/${geminiVariant}/verify`);
    await page.waitForSelector('[data-testid="check-ok"]');
    const verifyText = await page.locator('.checks').innerText();
    check('verify reports every check by name', /envelope_verified/.test(verifyText) && /chains_ok/.test(verifyText));
    check('and the run verifies', (await page.locator('.check.ok').count()) >= 4, verifyText.replace(/\n/g, ' '));

    // A deep link is the reason for using a router at all: it has to survive a
    // reload, which means the server has to serve the shell for it.
    await page.reload();
    await page.waitForSelector('[data-testid="check-ok"]');
    check('a deep link survives a hard reload', page.url().endsWith('/verify'));
    await shoot(page, 'verify');

    check('no console errors anywhere in the walk', consoleErrors.length === 0, consoleErrors.slice(0, 3));
    // Every variant the experiment planned has a run behind it, so the summary
    // reports no gaps of its own making.
    const summaryJson = await (await fetch(`${lab.url}/api/experiments/${experimentId}/summary`)).json();
    check(
      'the summary reports no missing runs',
      !summaryJson.warnings.some((w: { kind: string }) => w.kind === 'run_missing'),
      summaryJson.warnings,
    );
  } finally {
    await browser?.close();
    await lab.close();
  }

  console.log(`\nscreenshots: ${SHOTS}`);
  console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Full-page screenshot, named for the step it documents. */
async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** A seed repo with one commit, which is all `createExperiment` requires. */
function seedRepoFor(root: string): string {
  const dir = join(root, 'seed');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'lab@example.invalid');
  git(dir, 'config', 'user.name', 'squad-lab');
  writeFileSync(join(dir, 'README.md'), '# seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
