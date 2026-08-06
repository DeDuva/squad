/**
 * The frame log, which is what makes SSE replay a claim rather than a hope.
 *
 * Three properties, each of which fails silently in a way that looks like a
 * working stream: ids that restart after a lab restart, a gap at the reconnect
 * seam, and a duplicate at the same seam. The middle one is the dangerous one —
 * a browser cannot tell a frame that never arrived from one that never existed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ExperimentEventLog,
  sseFrame,
  sseHeartbeat,
  type LabFrame,
} from '../packages/squad-lab/src/event-log.js';

let root: string;
let path: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lab-log-'));
  path = join(root, 'events.jsonl');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('ExperimentEventLog', () => {
  it('numbers frames from one, monotonically', () => {
    const log = new ExperimentEventLog(path);
    const a = log.append({ type: 'phase', variantId: 'v1', data: { phase: 'running' } });
    const b = log.append({ type: 'bus', variantId: 'v1', data: { type: 'session:created' } });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(log.head).toBe(2);
  });

  it('keeps numbering where the file left off after a restart', () => {
    const before = new ExperimentEventLog(path);
    before.append({ type: 'phase', variantId: 'v1', data: {} });
    before.append({ type: 'phase', variantId: 'v1', data: {} });

    // A new process, same file. Numbering from memory would restart at 1 and
    // hand a reconnecting browser frames it has already rendered under ids it
    // has already seen.
    const after = new ExperimentEventLog(path);
    expect(after.head).toBe(2);
    expect(after.append({ type: 'phase', variantId: 'v1', data: {} }).seq).toBe(3);
  });

  it('survives the torn last line a crash leaves behind', () => {
    const log = new ExperimentEventLog(path);
    log.append({ type: 'phase', variantId: 'v1', data: {} });
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"seq":2,"type":"pha`);

    const reopened = new ExperimentEventLog(path);
    expect(reopened.head).toBe(1);
    expect(reopened.read(0)).toHaveLength(1);
  });

  it('replays only what the client has not seen', () => {
    const log = new ExperimentEventLog(path);
    for (let i = 0; i < 5; i += 1) log.append({ type: 'phase', variantId: 'v1', data: { i } });

    const seen: LabFrame[] = [];
    const stop = log.replayAndFollow(3, (f) => seen.push(f));
    expect(seen.map((f) => f.seq)).toEqual([4, 5]);
    stop();
  });

  it('leaves no gap and no duplicate when a frame lands mid-replay', () => {
    const log = new ExperimentEventLog(path);
    for (let i = 0; i < 3; i += 1) log.append({ type: 'phase', variantId: 'v1', data: { i } });

    // The seam: a frame arrives while the reconnecting client is still reading
    // the file. Subscribing after the read would lose it; replaying without
    // dropping what the read already covered would send it twice.
    const seen: LabFrame[] = [];
    const stop = log.replayAndFollow(0, (frame) => {
      seen.push(frame);
      if (frame.seq === 2) log.append({ type: 'bus', variantId: 'v1', data: { late: true } });
    });

    expect(seen.map((f) => f.seq)).toEqual([1, 2, 3, 4]);
    expect(new Set(seen.map((f) => f.seq)).size).toBe(seen.length);
    stop();
  });

  it('stops delivering once unsubscribed', () => {
    const log = new ExperimentEventLog(path);
    const seen: LabFrame[] = [];
    const stop = log.replayAndFollow(0, (f) => seen.push(f));
    log.append({ type: 'phase', variantId: 'v1', data: {} });
    stop();
    log.append({ type: 'phase', variantId: 'v1', data: {} });
    expect(seen).toHaveLength(1);
  });

  it('keeps one broken consumer from starving the others', () => {
    const log = new ExperimentEventLog(path);
    const seen: number[] = [];
    log.replayAndFollow(0, () => {
      throw new Error('this subscriber is broken');
    });
    log.replayAndFollow(0, (f) => seen.push(f.seq));
    log.append({ type: 'phase', variantId: 'v1', data: {} });
    // The log is a view of the work, never the work itself.
    expect(seen).toEqual([1]);
  });
});

describe('SSE framing', () => {
  it('carries the sequence number as the event id', () => {
    const frame: LabFrame = { seq: 7, type: 'bus', variantId: 'v1', at: 'now', data: { a: 1 } };
    expect(sseFrame(frame)).toContain('id: 7\n');
    expect(sseFrame(frame)).toContain('event: bus\n');
    expect(sseFrame(frame).endsWith('\n\n')).toBe(true);
  });

  it('gives a heartbeat no id at all', () => {
    // A heartbeat is not replayable content. Numbering it would advance the
    // client's resume point past a frame that never had any, and reconnecting
    // on that id would ask to resume from nothing.
    expect(sseHeartbeat()).not.toContain('id:');
    expect(sseHeartbeat()).toContain('event: heartbeat');
  });
});
