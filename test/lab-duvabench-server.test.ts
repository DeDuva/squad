/**
 * The bench server, and the frame it must never lose.
 *
 * A monitor view that drops a frame is worse than one that shows nothing: the
 * grid simply stays wrong, and nothing about it looks broken. Two seams can
 * lose one — a page refresh and a server restart — and both are covered here by
 * driving the real HTTP surface rather than the functions behind it.
 *
 * The guarantee comes from where the ids come from. `progress.jsonl` is
 * append-only and already the scheduler's source of truth, so a frame's id is
 * its line number in that file. An in-memory counter would restart at 1 after a
 * crash and hand the browser frames it had already rendered under ids it had
 * already seen.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBenchServer,
  readFrames,
  sseFrame,
  sseHeartbeat,
  startBenchServer,
} from '../packages/duva-bench/src/server.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

const dirs: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'duvabench-server-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'progress.jsonl'), '');
  return dir;
}

const write = (dir: string, ...events: object[]): void => {
  for (const event of events) appendFileSync(join(dir, 'progress.jsonl'), `${JSON.stringify(event)}\n`);
};

const SPEC = `title: server fixture
tasks:
  - {id: retry, goal: g.md, seed: seed, grader: g.mjs, graderSha256: "${'a'.repeat(64)}"}
arms:
  - id: one
    harness: ai-sdk
    model: {provider: anthropic, tier: fast}
    toolset: {name: default, docsGrade: reference}
    topology: single
budgetUsd: 1
concurrency: 1
preRegistration:
  primaryMetric: acceptance
  secondaryMetrics: []
  repetitions: 2
  exclusionRules: []
  amendments: []
`;

async function serve(dir: string, specs: string[] = []) {
  const started = await startBenchServer({
    adp: { baseUrl: 'http://adp.invalid', owner: 'o', repo: 'r', token: 'secret-token' },
    root: dir,
    specs,
    port: 0,
  });
  servers.push(started);
  return started;
}

/** Read an SSE stream until `count` `progress` frames have arrived. */
async function collectFrames(
  url: string,
  count: number,
  lastEventId?: number,
): Promise<Array<{ id: number; data: Record<string, unknown> }>> {
  const controller = new AbortController();
  const response = await fetch(url, {
    signal: controller.signal,
    ...(lastEventId !== undefined ? { headers: { 'last-event-id': String(lastEventId) } } : {}),
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ id: number; data: Record<string, unknown> }> = [];
  let buffer = '';

  const deadline = Date.now() + 8000;
  while (frames.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const id = /^id: (\d+)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (id && data) frames.push({ id: Number(id), data: JSON.parse(data) });
    }
  }
  controller.abort();
  return frames;
}

// ─── Frame ids come from the file ────────────────────────────────────────

describe('frame ids', () => {
  it('are line numbers, so they survive anything that restarts a counter', () => {
    const dir = root();
    write(dir, { kind: 'study' }, { kind: 'started' }, { kind: 'finished' });
    expect(readFrames(join(dir, 'progress.jsonl')).map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it('slice from a resume point without re-reading what was sent', () => {
    const dir = root();
    write(dir, { kind: 'a' }, { kind: 'b' }, { kind: 'c' });
    const rest = readFrames(join(dir, 'progress.jsonl'), 2);
    expect(rest.map((f) => f.seq)).toEqual([3]);
  });

  it('tolerate a torn last line, which is a crash and not corruption', () => {
    const dir = root();
    write(dir, { kind: 'a' });
    appendFileSync(join(dir, 'progress.jsonl'), '{"kind":"half');
    // The whole frame is still delivered; the torn one waits for its newline.
    expect(readFrames(join(dir, 'progress.jsonl')).map((f) => f.seq)).toEqual([1]);
  });

  it('never numbers a heartbeat', () => {
    // A numbered heartbeat would advance a client's resume point past nothing,
    // and the reconnect would ask to continue from a frame that had no content.
    expect(sseHeartbeat()).not.toContain('id:');
    expect(sseFrame({ seq: 4, data: { kind: 'x' } })).toContain('id: 4');
  });
});

// ─── The stream ──────────────────────────────────────────────────────────

describe('the progress stream', () => {
  it('replays what already happened, then follows', async () => {
    const dir = root();
    write(dir, { kind: 'study', digest: 'd' }, { kind: 'started', externalRef: 'x:a:t:r1' });
    const { url } = await serve(dir);

    const frames = await collectFrames(`${url}/api/progress/stream`, 2);
    expect(frames.map((f) => f.id)).toEqual([1, 2]);
    expect(frames[1]!.data.externalRef).toBe('x:a:t:r1');
  });

  it('resumes from Last-Event-ID with neither a gap nor a duplicate', async () => {
    const dir = root();
    write(dir, { kind: 'study' }, { kind: 'started', externalRef: 'a' }, { kind: 'finished', externalRef: 'a' });
    const { url } = await serve(dir);

    const first = await collectFrames(`${url}/api/progress/stream`, 3);
    expect(first.map((f) => f.id)).toEqual([1, 2, 3]);

    // The seam: more work happens while nobody is listening.
    write(dir, { kind: 'started', externalRef: 'b' }, { kind: 'finished', externalRef: 'b' });

    const resumed = await collectFrames(`${url}/api/progress/stream`, 2, 3);
    expect(resumed.map((f) => f.id)).toEqual([4, 5]);
    expect(resumed.map((f) => f.data.externalRef)).toEqual(['b', 'b']);
  });

  it('loses no frame across a server restart', async () => {
    // The gate: kill the server mid-study, append while it is down, restart,
    // reconnect on the last id seen. Because the ids are the file's, the new
    // process continues the same numbering the browser already has.
    const dir = root();
    write(dir, { kind: 'study' }, { kind: 'started', externalRef: 'a' });

    const first = await serve(dir);
    const before = await collectFrames(`${first.url}/api/progress/stream`, 2);
    expect(before.map((f) => f.id)).toEqual([1, 2]);
    await first.close();
    servers.length = 0;

    write(dir, { kind: 'finished', externalRef: 'a' }, { kind: 'started', externalRef: 'b' });

    const second = await serve(dir);
    const after = await collectFrames(`${second.url}/api/progress/stream`, 2, before.at(-1)!.id);

    expect(after.map((f) => f.id)).toEqual([3, 4]);
    const everySeq = [...before, ...after].map((f) => f.id);
    expect(everySeq).toEqual([1, 2, 3, 4]);
    expect(new Set(everySeq).size).toBe(everySeq.length);
  });
});

// ─── Define ──────────────────────────────────────────────────────────────

describe('the define view', () => {
  it('digests a spec and lists its arms', async () => {
    const dir = root();
    const spec = join(dir, 'study.yaml');
    writeFileSync(spec, SPEC);
    const app = createBenchServer({
      adp: { baseUrl: 'http://adp.invalid', owner: 'o', repo: 'r', token: 't' },
      root: dir,
      specs: [spec],
    });

    const res = await app.inject({ method: 'POST', url: '/api/validate', payload: { file: spec } });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.trials).toBe(2);
    expect(body.arms[0].id).toBe('one');
    expect(body.preRegistration.amended).toBe(false);
    await app.close();
  });

  it('returns every problem rather than the first', async () => {
    const dir = root();
    const app = createBenchServer({
      adp: { baseUrl: 'http://adp.invalid', owner: 'o', repo: 'r', token: 't' },
      root: dir,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/validate',
      payload: { spec: { title: '', tasks: [], arms: [], budgetUsd: -1 } },
    });
    expect(res.json().ok).toBe(false);
    expect(res.json().errors.length).toBeGreaterThanOrEqual(3);
    await app.close();
  });
});

// ─── The token never leaves the process ──────────────────────────────────

describe('the read proxy', () => {
  it('never puts the ADP token in anything the browser receives', async () => {
    const dir = root();
    const spec = join(dir, 'study.yaml');
    writeFileSync(spec, SPEC);
    const { url } = await serve(dir, [spec]);

    for (const path of ['/', '/api/config', '/api/progress']) {
      const text = await (await fetch(`${url}${path}`)).text();
      // A token handed to a page is a token in a browser history, a proxy log
      // and an extension.
      expect(text).not.toContain('secret-token');
    }
  });

  it('serves only the specs it was started with', async () => {
    const dir = root();
    const spec = join(dir, 'study.yaml');
    writeFileSync(spec, SPEC);
    const { url } = await serve(dir, [spec]);

    expect((await fetch(`${url}/api/spec?file=${encodeURIComponent(spec)}`)).status).toBe(200);
    // Otherwise the endpoint is a file-read primitive wearing a study's name.
    expect((await fetch(`${url}/api/spec?file=/etc/passwd`)).status).toBe(403);
  });

  it('resolves owner and repo from its own configuration, never the request', async () => {
    const dir = root();
    const { url } = await serve(dir);
    const config = await (await fetch(`${url}/api/config`)).json();
    expect(config.adp).toEqual({ baseUrl: 'http://adp.invalid', owner: 'o', repo: 'r' });
    expect(config.adp).not.toHaveProperty('token');
  });
});

// ─── The page ────────────────────────────────────────────────────────────

describe('the page', () => {
  it('carries all three views and renders missing data as words', async () => {
    const dir = root();
    const { url } = await serve(dir);
    const html = await (await fetch(url)).text();

    for (const view of ['Define', 'Monitor', 'Analyze']) expect(html).toContain(view);
    expect(html).toContain('unscored');
    expect(html).toContain('unpriced');
    // Bands, never one ordering.
    expect(html).toContain('must not be ranked together');
  });
});
