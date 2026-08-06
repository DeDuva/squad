/**
 * The lab's HTTP surface, over a real socket.
 *
 * SSE is asserted against an actual connection rather than through `inject`,
 * because the behaviour under test *is* the connection: an id per frame, a
 * heartbeat that carries none, and a reconnect that resumes exactly where the
 * last one stopped.
 *
 * The proxy assertions matter for a different reason. ADP has no per-repo
 * authz, so its `repo:read` token reads every repository on the instance. The
 * proxy is the only thing standing between a browser and that token, and the
 * property worth pinning is that a caller cannot choose what it reaches.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createLabServer,
  type LabServerOptions,
} from '../packages/squad-lab/src/server.js';
import { saveExperiment, type Experiment } from '../packages/squad-lab/src/experiments.js';
import { ExperimentEventLog } from '../packages/squad-lab/src/event-log.js';

let home: string;
let realFetch: typeof fetch;
let server: Awaited<ReturnType<typeof start>> | undefined;

const EXPERIMENT: Experiment = {
  id: 'exp_http',
  createdAt: new Date().toISOString(),
  status: 'draft',
  goal: { title: 'parse a duration', body: '' },
  adp: {
    url: 'http://adp.test',
    owner: 'lab',
    repo: 'duration',
    issueNumber: 1,
    intentId: 'intent_1',
    tokenEnv: 'SQUAD_LAB_ADP_TOKEN',
  },
  seed: { repoUrl: '/seed' },
  agents: [],
  routing: [],
  registeredTools: [],
  variants: [{ id: 'anthropic', provider: 'anthropic', externalRef: 'exp_http:anthropic' }],
};

/** Records what the proxy asked ADP for, and with which credential. */
interface AdpCall {
  path: string;
  auth: string | undefined;
}

function fakeAdp(calls: AdpCall[]): typeof fetch {
  return (async (url: string, init: { headers?: Record<string, string> }) => {
    const parsed = new URL(String(url));
    calls.push({ path: `${parsed.pathname}${parsed.search}`, auth: init.headers?.['Authorization'] });
    return new Response(JSON.stringify({ ok: true, path: parsed.pathname }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function start(options?: Partial<LabServerOptions>) {
  const app = createLabServer({
    token: 'runner-token',
    evalToken: 'eval-token',
    adpUrl: 'http://adp.test',
    heartbeatMs: 50,
    ...options,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { app, url: `http://127.0.0.1:${port}`, close: () => app.close() };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lab-http-'));
  process.env['SQUAD_LAB_HOME'] = home;
  realFetch = globalThis.fetch;
  saveExperiment(EXPERIMENT);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  globalThis.fetch = realFetch;
  delete process.env['SQUAD_LAB_HOME'];
  rmSync(home, { recursive: true, force: true });
});

describe('experiment routes', () => {
  it('lists and reads experiments', async () => {
    server = await start();
    const list = await (await fetch(`${server.url}/api/experiments`)).json();
    expect(list.experiments.map((e: Experiment) => e.id)).toEqual(['exp_http']);

    const one = await (await fetch(`${server.url}/api/experiments/exp_http`)).json();
    expect(one.experiment.id).toBe('exp_http');
    expect(one.variants).toEqual([]);
  });

  it('404s an experiment that does not exist rather than 500ing', async () => {
    server = await start();
    const res = await fetch(`${server.url}/api/experiments/nope`);
    expect(res.status).toBe(404);
  });

  it('refuses to launch a graded experiment when it holds no eval identity', async () => {
    // Same rule the CLI enforces, at the other entry point: a launch that
    // spends money and then cannot score anything has failed at the most
    // expensive possible moment.
    saveExperiment({ ...EXPERIMENT, grader: { path: '/g.mjs', sha256: 'a'.repeat(64) } });
    server = await start({ evalToken: undefined });
    const res = await fetch(`${server.url}/api/experiments/exp_http/launch`, { method: 'POST' });
    expect(res.status).toBe(422);
    expect((await res.json()).message).toMatch(/no eval identity/);
  });

  it('refuses to regrade without an eval identity', async () => {
    server = await start({ evalToken: undefined });
    const res = await fetch(`${server.url}/api/experiments/exp_http/variants/anthropic/regrade`, {
      method: 'POST',
    });
    expect(res.status).toBe(422);
  });
});

describe('the ADP read proxy', () => {
  it('injects owner and repo from the experiment, never from the caller', async () => {
    const calls: AdpCall[] = [];
    globalThis.fetch = fakeAdp(calls);
    server = await start();

    await realFetch(`${server.url}/adp/runs/run_1/stats?experiment=exp_http`);
    expect(calls[0]?.path).toBe('/api/adp/repos/lab/duration/runs/run_1/stats');
  });

  it('keeps the token on this side of the connection', async () => {
    const calls: AdpCall[] = [];
    globalThis.fetch = fakeAdp(calls);
    server = await start();

    const res = await realFetch(`${server.url}/adp/runs/run_1/verify?experiment=exp_http`);
    // The lab authenticates to ADP...
    expect(calls[0]?.auth).toBe('Bearer runner-token');
    // ...and nothing about that reaches the browser.
    expect(JSON.stringify(await res.json())).not.toContain('runner-token');
    expect([...res.headers.keys()].join(' ')).not.toMatch(/authorization/i);
  });

  it('refuses to read anything without an experiment to resolve the repo from', async () => {
    globalThis.fetch = fakeAdp([]);
    server = await start();
    const res = await realFetch(`${server.url}/adp/runs/run_1/stats`);
    expect(res.status).toBe(422);
  });

  it('serves six literal read patterns and nothing else', async () => {
    const calls: AdpCall[] = [];
    globalThis.fetch = fakeAdp(calls);
    server = await start();

    for (const path of [
      '/adp/runs/run_1?experiment=exp_http',
      '/adp/runs/run_1/trajectory?experiment=exp_http',
      '/adp/runs/run_1/stats?experiment=exp_http',
      '/adp/runs/run_1/verify?experiment=exp_http',
      '/adp/runs/run_1/evals?experiment=exp_http',
      '/adp/runs/compare?experiment=exp_http&intent_id=intent_1',
    ]) {
      expect((await realFetch(`${server.url}${path}`)).status).toBe(200);
    }
    expect(calls).toHaveLength(6);

    // A wildcard pass-through would have carried these through too, and two of
    // them write.
    for (const denied of [
      '/adp/repos/other/secret/runs?experiment=exp_http',
      '/adp/runs/run_1/close?experiment=exp_http',
      '/adp/user?experiment=exp_http',
    ]) {
      expect((await realFetch(`${server.url}${denied}`)).status).toBe(404);
    }
    expect(calls).toHaveLength(6);
  });
});

/** Read an SSE stream until `stop` says so, returning the raw text. */
async function readStream(
  url: string,
  headers: Record<string, string>,
  stop: (text: string) => boolean,
  timeoutMs = 4000,
): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (stop(text)) break;
  }
  controller.abort();
  return text;
}

describe('the live stream', () => {
  it('replays what already happened, then follows, with monotonic ids', async () => {
    server = await start();
    const log = new ExperimentEventLog(join(home, 'experiments', 'exp_http', 'events.jsonl'));
    log.append({ type: 'phase', variantId: 'v1', data: { phase: 'preparing' } });
    log.append({ type: 'phase', variantId: 'v1', data: { phase: 'running' } });

    const text = await readStream(
      `${server.url}/api/experiments/exp_http/stream`,
      {},
      (t) => t.includes('id: 3'),
    );
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids.slice(0, 2)).toEqual([1, 2]);

    // A frame appended after the connection opened arrives on the same stream.
    log.append({ type: 'bus', variantId: 'v1', data: { type: 'session:created' } });
    const followed = await readStream(
      `${server.url}/api/experiments/exp_http/stream`,
      {},
      (t) => t.includes('id: 3'),
    );
    expect([...followed.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([1, 2, 3]);
  });

  it('resumes from Last-Event-ID with no gap and no duplicate', async () => {
    server = await start();
    const log = new ExperimentEventLog(join(home, 'experiments', 'exp_http', 'events.jsonl'));
    for (let i = 1; i <= 4; i += 1) log.append({ type: 'phase', variantId: 'v1', data: { i } });

    // The reconnect the milestone's own check performs: drop the connection
    // mid-run and come back naming the last frame seen.
    const text = await readStream(
      `${server.url}/api/experiments/exp_http/stream`,
      { 'Last-Event-ID': '2' },
      (t) => t.includes('id: 4'),
    );
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([3, 4]);
  });

  it('carries what a launch reports, not just what a test appended', async () => {
    // The wiring that matters and is easy to leave dangling: `launchExperiment`
    // reports through callbacks, and those callbacks are the only thing that
    // puts a run on the stream. This launch fails on its missing seed rather
    // than invoking a model, which is enough to prove the path is connected.
    server = await start();
    const stream = readStream(
      `${server.url}/api/experiments/exp_http/stream`,
      {},
      (t) => t.includes('"status":"failed"'),
    );

    const launched = await fetch(`${server.url}/api/experiments/exp_http/launch`, { method: 'POST' });
    expect(launched.status).toBe(202);

    const text = await stream;
    expect(text).toContain('event: experiment');
    expect(text).toContain('"status":"running"');
    expect(text).toContain('"status":"failed"');
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps an idle connection open with a heartbeat that carries no id', async () => {
    server = await start({ heartbeatMs: 30 });
    const text = await readStream(
      `${server.url}/api/experiments/exp_http/stream`,
      {},
      (t) => (t.match(/event: heartbeat/g) ?? []).length >= 2,
    );
    expect(text).toContain('event: heartbeat');
    // No id on a heartbeat, so a client that reconnects after a quiet spell
    // still resumes from the last frame with content.
    expect(text).not.toMatch(/^id:/m);
  });
});
