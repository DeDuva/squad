/**
 * The recorder's durable buffer.
 *
 * An in-memory buffer loses whatever it holds when the process dies, and the
 * process dying mid-assignment is not an exotic case — it is the case an
 * orchestrator most wants recorded. So every event is written to disk as it is
 * enqueued, *before* it is eligible to be sent, and only the acknowledged
 * high-water mark is used to decide what still needs sending. A crash then
 * costs latency rather than trajectory.
 *
 * Layout, one directory per run so cleanup is a single rmdir:
 *
 * ```
 * .squad/spool/<runId>/sessions.json        agent name -> ADP session id
 * .squad/spool/<runId>/<adpSessionId>.jsonl one enqueued event per line
 * .squad/spool/<runId>/<adpSessionId>.ack   highest producer_seq ADP holds
 * ```
 *
 * `sessions.json` is what makes a restart a *rejoin* rather than a fresh start:
 * without it the recorder would open new ADP sessions and replay a spool into
 * chains that no longer exist, splitting one agent's trajectory in two.
 *
 * @module adp/spool
 */

import { mkdir, readdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdpEvent } from './client.js';

/** An event as spooled: always numbered, always identified. */
export type SpooledEvent = AdpEvent & { producer_seq: number; client_event_id: string };

export interface SpooledSessions {
  coordinator?: string;
  agents: Record<string, string>;
}

export class TrajectorySpool {
  /** Serializes writes, so "spooled before sent" holds without async enqueue. */
  private chain: Promise<void> = Promise.resolve();
  private ensured = false;

  constructor(private readonly dir: string) {}

  /** The directory this run spools into — useful for assertions and cleanup. */
  get path(): string {
    return this.dir;
  }

  private async ensureDir(): Promise<void> {
    if (this.ensured) return;
    await mkdir(this.dir, { recursive: true });
    // The spool self-ignores.
    //
    // It lives under `.squad/` inside the repository the agents are working in,
    // and an assignment that ends with `git add -A` will otherwise commit the
    // recorder's recovery log into the project it was recording. Squad's own
    // .gitignore cannot help: this directory is in *someone else's* repo. A
    // `.gitignore` written beside the spool travels with it, so recording stays
    // invisible to the work it observes — which is the only acceptable
    // footprint for an observer.
    // Written *inside* the run's directory rather than beside it: `*` ignores
    // the file itself too, so git reports nothing for a directory holding only
    // ignored files, and the whole thing disappears with the spool at close
    // instead of leaving residue in someone's repository.
    try {
      await writeFile(join(this.dir, '.gitignore'), '*\n', { encoding: 'utf8', flag: 'w' });
    } catch {
      /* best-effort: an unwritable parent is not a reason to stop recording */
    }
    this.ensured = true;
  }

  /**
   * Queue an event for durable storage and return the promise covering it.
   * Callers hold the returned promise; `drain()` waits for everything queued so
   * far, which is what a flush awaits before putting anything on the wire.
   */
  append(sessionId: string, event: SpooledEvent): Promise<void> {
    this.chain = this.chain.then(async () => {
      await this.ensureDir();
      await appendFile(join(this.dir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8');
    });
    return this.chain;
  }

  /** Resolves once every queued write has hit disk. */
  async drain(): Promise<void> {
    await this.chain;
  }

  async events(sessionId: string): Promise<SpooledEvent[]> {
    try {
      const raw = await readFile(join(this.dir, `${sessionId}.jsonl`), 'utf8');
      return raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as SpooledEvent);
    } catch {
      return [];
    }
  }

  /** The highest producer_seq ADP has acknowledged, or 0 if none. */
  async ack(sessionId: string): Promise<number> {
    try {
      const raw = await readFile(join(this.dir, `${sessionId}.ack`), 'utf8');
      const value = Number.parseInt(raw.trim(), 10);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  async recordAck(sessionId: string, acceptedThrough: number): Promise<void> {
    this.chain = this.chain.then(async () => {
      await this.ensureDir();
      await writeFile(join(this.dir, `${sessionId}.ack`), String(acceptedThrough), 'utf8');
    });
    await this.chain;
  }

  /** Every session this spool holds events for. */
  async sessionIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir);
      return entries.filter((e) => e.endsWith('.jsonl')).map((e) => e.slice(0, -'.jsonl'.length));
    } catch {
      return [];
    }
  }

  async saveSessions(sessions: SpooledSessions): Promise<void> {
    this.chain = this.chain.then(async () => {
      await this.ensureDir();
      await writeFile(join(this.dir, 'sessions.json'), JSON.stringify(sessions), 'utf8');
    });
    await this.chain;
  }

  async loadSessions(): Promise<SpooledSessions | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, 'sessions.json'), 'utf8')) as SpooledSessions;
    } catch {
      return undefined;
    }
  }

  /**
   * Drop the run's spool. Called only after a successful close or abandon —
   * i.e. once ADP has attested to the trajectory, at which point the local copy
   * is redundant rather than merely stale.
   */
  async destroy(): Promise<void> {
    await this.drain();
    await rm(this.dir, { recursive: true, force: true });
  }
}
