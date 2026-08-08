/**
 * Walk the three views in a real browser: define → run → analyze.
 *
 * The offline tests prove the server's seams hold. This proves the page built
 * on them actually works — which is a different claim, and the one that was
 * false in squad-lab's own history more than once, because a stream can be
 * perfectly correct and still render nothing.
 *
 * Needs a live ADP and a study that has already run. Costs no model calls: it
 * reads a finished study rather than starting one.
 *
 *   SQUAD_LAB_ADP_TOKEN=… npm run ui-check -w @deduvafork/duva-bench -- \
 *     --spec=/path/study.yaml --root=/path/study-root --owner=duvabench --repo=s6
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { startBenchServer } from '../src/server.js';

const arg = (name: string, fallback?: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = hit?.slice(name.length + 3);
  if (value === undefined && fallback === undefined) throw new Error(`missing required --${name}=`);
  return value ?? fallback!;
};

const step = (label: string): void => console.log(`  ok  ${label}`);

async function main(): Promise<number> {
  const tokenEnv = arg('token-env', 'SQUAD_LAB_ADP_TOKEN');
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`no ADP token in ${tokenEnv}`);

  const spec = arg('spec');
  const root = arg('root');
  mkdirSync(root, { recursive: true });
  const progress = join(root, 'progress.jsonl');
  if (!existsSync(progress)) writeFileSync(progress, '');

  const server = await startBenchServer({
    adp: { baseUrl: arg('adp-url', 'http://127.0.0.1:8793'), owner: arg('owner'), repo: arg('repo'), token },
    root,
    specs: [spec],
    port: 0,
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  let failed = 0;
  const fail = (why: string): void => {
    failed += 1;
    console.log(`  FAIL ${why}`);
  };

  try {
    // Not `networkidle`: the page holds an open EventSource by design, so the
    // network is never idle and waiting for it is waiting forever.
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    // `attached`, not visible: an <option> is never "visible" to Playwright.
    await page.waitForSelector('#spec-pick option', { state: 'attached' });
    step('page loads');

    // ── Define ───────────────────────────────────────────────────────
    await page.click('#load');
    await page.waitForFunction(() => (document.querySelector('#spec') as HTMLTextAreaElement).value.length > 0);
    await page.click('#validate');
    await page.waitForSelector('#define-out table');

    const digest = (await page.textContent('#define-out code'))?.trim() ?? '';
    if (!/^[0-9a-f]{64}$/.test(digest)) fail(`define did not show a study digest (got ${digest})`);
    else step(`define shows digest ${digest.slice(0, 12)}`);

    // The digest the editor shows must be the digest the scheduler used, or the
    // Define view quietly disagrees with the thing it is defining.
    const onDisk = (await (await fetch(`${server.url}/api/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: spec }),
    })).json()) as { digest?: string };
    if (onDisk.digest !== digest) fail(`edited digest ${digest.slice(0, 12)} != file digest ${String(onDisk.digest).slice(0, 12)}`);
    else step('the edited spec digests identically to the file');

    // ── Monitor ──────────────────────────────────────────────────────
    await page.click('#tab-monitor');
    // A frame appended *now* must appear without a reload: the stream is live,
    // and the id it carries is the file's line number.
    appendFileSync(progress, `${JSON.stringify({ at: new Date().toISOString(), kind: 'started', externalRef: 'ui-check:probe:r1' })}\n`);
    try {
      await page.waitForSelector('text=ui-check:probe:r1', { timeout: 10_000 });
      step('monitor renders a frame appended after the page opened');
    } catch {
      fail('monitor did not render a live frame');
    }

    appendFileSync(progress, `${JSON.stringify({ at: new Date().toISOString(), kind: 'finished', externalRef: 'ui-check:probe:r1', outcome: 'closed', verified: true, usd: 0.01 })}\n`);
    try {
      await page.waitForSelector('.cell .ok', { timeout: 10_000 });
      step('monitor shows a per-trial verify badge');
    } catch {
      fail('monitor did not show a verify badge');
    }

    // ── Analyze ──────────────────────────────────────────────────────
    await page.click('#tab-analyze');
    await page.click('#analyze');
    try {
      await page.waitForSelector('#analyze-out table', { timeout: 30_000 });
      step('analyze renders tables read from ADP');
    } catch {
      fail('analyze rendered nothing');
    }

    const html = (await page.content()) ?? '';
    if (html.includes(token)) fail('the ADP token reached the browser');
    else step('the ADP token never reached the browser');

    const drill = await page.$('a[data-run]');
    if (drill) {
      await drill.click();
      try {
        await page.waitForSelector('#drill table', { timeout: 15_000 });
        step('drill-down resolves a trajectory through the read proxy');
      } catch {
        fail('drill-down rendered nothing');
      }
    } else {
      console.log('  --  no trial with a run id to drill into');
    }
  } finally {
    await browser.close();
    await server.close();
  }

  console.log(failed === 0 ? '\nui-check passed' : `\n${failed} failure(s)`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
