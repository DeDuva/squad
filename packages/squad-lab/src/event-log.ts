/**
 * The experiment's frame log, and the thing that makes SSE replay honest.
 *
 * Every frame the browser can receive is appended to one file first and given a
 * monotonic sequence number as it lands. The number is the file's, not the
 * connection's — which is what lets `Last-Event-ID` survive a page refresh *and*
 * a lab restart. Numbering from an in-memory counter would restart at 1 and
 * hand the browser frames it has already rendered, under ids it has already
 * seen.
 *
 * Two rules keep the stream trustworthy, and both are easy to get wrong:
 *
 *  - **Subscribe before reading.** A reconnecting client that reads the file
 *    and *then* subscribes loses any frame appended in between. This subscribes
 *    first, buffers what arrives, and drops buffered frames already covered by
 *    the file read — so the seam produces neither a gap nor a duplicate.
 *  - **Heartbeats carry no id.** They exist to keep an idle connection open,
 *    not to be replayed. Numbering them would advance `Last-Event-ID` past
 *    nothing, and a client that reconnected on that id would ask to resume from
 *    a frame that never had content.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type FrameType = 'phase' | 'bus' | 'variant' | 'experiment';

export interface LabFrame {
  /** Monotonic within one experiment, assigned at append. */
  seq: number;
  type: FrameType;
  /** Absent on experiment-level frames. */
  variantId?: string;
  at: string;
  /**
   * For `bus`, the `SquadEvent` **verbatim** — no lab-side renaming, so
   * `runtime/event-payloads.ts` stays the contract document for both sides.
   */
  data: unknown;
}

export type FrameInput = Omit<LabFrame, 'seq' | 'at'>;

export class ExperimentEventLog {
  private seq = 0;
  private readonly subscribers = new Set<(frame: LabFrame) => void>();

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.seq = lastSeqIn(path);
  }

  /** The highest sequence number handed out so far. */
  get head(): number {
    return this.seq;
  }

  append(input: FrameInput): LabFrame {
    this.seq += 1;
    const frame: LabFrame = { seq: this.seq, at: new Date().toISOString(), ...input };
    // One line, one write. A torn frame would be indistinguishable from a
    // truncated log, and the reader would silently skip it on replay.
    appendFileSync(this.path, `${JSON.stringify(frame)}\n`, 'utf8');
    for (const fn of [...this.subscribers]) {
      try {
        fn(frame);
      } catch {
        // A broken consumer must not stop the others, and must never stop the
        // experiment: this log is a view of the work, not the work.
      }
    }
    return frame;
  }

  /** Frames after `afterSeq`, read off disk so a restarted lab can still serve them. */
  read(afterSeq = 0): LabFrame[] {
    if (!existsSync(this.path)) return [];
    const out: LabFrame[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const frame = JSON.parse(line) as LabFrame;
        if (frame.seq > afterSeq) out.push(frame);
      } catch {
        // A half-written final line is the normal shape of a crash. Skipping it
        // is right; failing the whole replay because of it is not.
      }
    }
    return out;
  }

  /**
   * Replay from `afterSeq`, then follow live, with no gap and no duplicate
   * across the seam. Returns an unsubscribe function.
   */
  replayAndFollow(afterSeq: number, onFrame: (frame: LabFrame) => void): () => void {
    let buffered: LabFrame[] | null = [];
    let highest = afterSeq;

    const receive = (frame: LabFrame) => {
      if (buffered) {
        buffered.push(frame);
        return;
      }
      if (frame.seq <= highest) return;
      highest = frame.seq;
      onFrame(frame);
    };
    this.subscribers.add(receive);

    // Read *after* subscribing, so nothing appended during the read is lost.
    for (const frame of this.read(afterSeq)) {
      highest = Math.max(highest, frame.seq);
      onFrame(frame);
    }

    // Anything the file already covered is dropped here rather than sent twice.
    const pending = buffered;
    buffered = null;
    for (const frame of pending) receive(frame);

    return () => this.subscribers.delete(receive);
  }
}

/**
 * The last sequence number the log actually holds.
 *
 * Read from the file rather than remembered, because the case this exists for
 * is the one where nothing was remembered — a lab that restarted mid-run.
 */
function lastSeqIn(path: string): number {
  if (!existsSync(path)) return 0;
  let max = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const seq = (JSON.parse(line) as LabFrame).seq;
      if (typeof seq === 'number' && seq > max) max = seq;
    } catch {
      // See `read`: a torn last line is a crash, not a corrupt log.
    }
  }
  return max;
}

/** SSE wire format. `id:` is omitted deliberately for heartbeats. */
export function sseFrame(frame: LabFrame): string {
  return `id: ${frame.seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
}

export function sseHeartbeat(): string {
  return `event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;
}
