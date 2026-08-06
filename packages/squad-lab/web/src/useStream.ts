/**
 * The live board's feed.
 *
 * `EventSource` is used rather than a hand-rolled fetch reader for one reason
 * that matters: the browser resends `Last-Event-ID` on its own reconnect, and
 * the lab numbers frames off the file, so a dropped connection resumes exactly
 * where it stopped — no gap, no duplicate — without any bookkeeping here.
 */

import { useEffect, useRef, useState } from 'react';

export interface LabFrame {
  seq: number;
  type: 'phase' | 'bus' | 'variant' | 'experiment';
  variantId?: string;
  at: string;
  data: unknown;
}

export interface StreamState {
  frames: LabFrame[];
  connected: boolean;
  lastSeq: number;
}

/** How many frames the board keeps. A run produces thousands; a ticker shows tens. */
const KEEP = 400;

export function useStream(experimentId: string | undefined, enabled = true): StreamState {
  const [frames, setFrames] = useState<LabFrame[]>([]);
  const [connected, setConnected] = useState(false);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    if (!experimentId || !enabled) return;
    seen.current = new Set();
    const source = new EventSource(`/api/experiments/${experimentId}/stream`);

    const onFrame = (event: MessageEvent) => {
      const frame = JSON.parse(event.data) as LabFrame;
      // Belt and braces against a double-delivered frame: the server already
      // guarantees this, and a UI that silently doubled its event count would
      // be a hard thing to notice and a worse thing to debug.
      if (seen.current.has(frame.seq)) return;
      seen.current.add(frame.seq);
      setFrames((prev) => [...prev, frame].slice(-KEEP));
    };

    for (const type of ['phase', 'bus', 'variant', 'experiment']) {
      source.addEventListener(type, onFrame as EventListener);
    }
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    return () => source.close();
  }, [experimentId, enabled]);

  return { frames, connected, lastSeq: frames.at(-1)?.seq ?? 0 };
}
