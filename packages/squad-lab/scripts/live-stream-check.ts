/**
 * The lab server, end to end, against a real ADP and a real socket.
 *
 * M5's own check, run without invoking a model: boot the lab (which asserts
 * the two identities against ADP before it listens), create an experiment
 * (which really does file an issue and mint an intent), open the stream, drop
 * it mid-flight, and reconnect with `Last-Event-ID`.
 *
 * The reconnect is the point. A stream that replays too much and a stream that
 * replays too little both look like a working stream from the outside; only
 * comparing the two halves against the whole shows which one you have.
 *
 *   SQUAD_LAB_ADP_TOKEN=… SQUAD_LAB_EVAL_TOKEN=… \
 *     npm run stream-check -w @deduvafork/squad-lab
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startLabServer } from '../src/server.js';

const ADP_URL = process.env['ADP_URL'] ?? 'http://127.0.0.1:8793';
const REPO = process.env['ADP_REPO'] ?? `streamcheck-${Date.now().toString(36)}`;

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

/** A git repo with one commit, which is all `createExperiment` checks for. */
function seedRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'credential.helper=', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'lab@example.invalid');
  git('config', 'user.name', 'squad-lab');
  writeFileSync(join(dir, 'README.md'), '# seed\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  return dir;
}

/** Read an SSE stream until `stop`, or until the deadline. Returns raw text. */
async function readStream(
  url: string,
  headers: Record<string, string>,
  stop: (text: string) => boolean,
  timeoutMs = 8000,
): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (stop(text)) break;
    }
  } finally {
    controller.abort();
  }
  return text;
}

const idsIn = (text: string) => [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lab-stream-'));
  process.env['SQUAD_LAB_HOME'] = join(root, 'home');

  // Booting asserts the two identities against ADP before anything listens.
  const lab = await startLabServer({
    token: required('SQUAD_LAB_ADP_TOKEN'),
    evalToken: required('SQUAD_LAB_EVAL_TOKEN'),
    adpUrl: ADP_URL,
    port: 0,
    heartbeatMs: 1000,
  });
  console.log(`lab on ${lab.url} · ADP ${ADP_URL} · repo lab/${REPO}`);
  check('the lab booted with two distinct identities', true);

  const created = await fetch(`${lab.url}/api/experiments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      goal: { title: 'parse a duration', body: 'Export parseDuration(input).' },
      adp: { owner: 'lab', repo: REPO },
      seed: { repoUrl: seedRepo(join(root, 'seed')) },
      variants: [{ provider: 'anthropic' }, { provider: 'gemini' }],
    }),
  });
  const experiment = (await created.json()) as { id: string; adp: { intentId: string; issueNumber: number } };
  check('an experiment was created against real ADP', created.status === 201, {
    issue: experiment.adp?.issueNumber,
    intent: experiment.adp?.intentId?.slice(0, 8),
  });

  // Frames, produced by a real route rather than written behind the server's
  // back. `cancel` on an experiment with no live children is a no-op that still
  // reports what it did — exactly the shape we want without spending anything.
  const streamUrl = `${lab.url}/api/experiments/${experiment.id}/stream`;
  for (let i = 0; i < 3; i += 1) {
    await fetch(`${lab.url}/api/experiments/${experiment.id}/cancel`, { method: 'POST' });
  }

  const whole = await readStream(streamUrl, {}, (t) => idsIn(t).length >= 4);
  const all = idsIn(whole);
  check('ids arrive and are strictly increasing from 1', all.length >= 4 && all.every((n, i) => n === i + 1), all);
  check('every frame names its type', /^event: (experiment|phase|bus|variant)$/m.test(whole));

  // Drop it mid-stream and come back naming the last frame seen.
  const cut = Math.floor(all.length / 2);
  const resumed = await readStream(streamUrl, { 'Last-Event-ID': String(all[cut - 1]) }, (t) =>
    idsIn(t).length >= all.length - cut,
  );
  const after = idsIn(resumed);
  check('the reconnect resumes at the next frame', after[0] === all[cut], { resumedAt: after[0], expected: all[cut] });
  check('no gap: the two halves cover the whole stream', [...all.slice(0, cut), ...after].join() === all.join(), {
    firstHalf: all.slice(0, cut),
    secondHalf: after,
  });
  check('no duplicate: nothing appears in both halves', !after.some((n) => all.slice(0, cut).includes(n)), after);

  const idle = await readStream(streamUrl, { 'Last-Event-ID': String(all.at(-1)) }, (t) =>
    (t.match(/event: heartbeat/g) ?? []).length >= 2,
  );
  check('an idle connection heartbeats', (idle.match(/event: heartbeat/g) ?? []).length >= 2);
  // A heartbeat that carried an id would push the client's resume point past a
  // frame that never had content.
  check('heartbeats carry no id', idsIn(idle).length === 0);

  const proxied = await fetch(`${lab.url}/adp/runs/compare?experiment=${experiment.id}&intent_id=${experiment.adp.intentId}`);
  check('the ADP proxy reads through the lab', proxied.status === 200);
  check('and the token never crosses it', !JSON.stringify(await proxied.json()).includes('adp_pat_'));

  const denied = await fetch(`${lab.url}/adp/runs/x/close?experiment=${experiment.id}`);
  check('a route outside the six is not served', denied.status === 404);

  await lab.close();
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
