/**
 * The forked half of a variant.
 *
 * It exists so that a variant's environment, working directory and lifetime
 * belong to it alone: API keys and the `claude` credential chain are read
 * per-process, `session.abort()` is only cooperative so a wedged backend needs
 * a real kill, and a variant that dies must not take its siblings' event
 * streams with it.
 *
 * Events reach the parent over the fork's IPC channel rather than the WebSocket
 * bridge in the SDK. That bridge is right for an external consumer, but here it
 * would mean a port per variant, a port allocator and a binding story for
 * several loopback sockets — where IPC already exists, is authenticated by
 * process ancestry, and cannot be reached from off the box.
 */

import { runVariant, type VariantSpec } from './run-variant.js';
import type { ChildMessage } from './experiments.js';

function send(message: ChildMessage): void {
  process.send?.(message);
}

process.on('message', (raw) => {
  const msg = raw as { t: string; spec: VariantSpec };
  if (msg.t !== 'start') return;

  void (async () => {
    try {
      const result = await runVariant({
        ...msg.spec,
        onPhase: (phase, detail) => send({ t: 'phase', phase, detail }),
        // Forwarded verbatim, plus nothing. The UI's event vocabulary is the
        // SDK's, so `runtime/event-payloads.ts` stays the one contract both
        // sides read rather than each growing its own shape.
        onEvent: (event) => send({ t: 'bus', event }),
      });
      send({ t: 'result', result });
    } catch (error) {
      send({ t: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      // Leave nothing holding the loop open — a backend may have left a timer
      // or socket behind, and a child that never exits is a variant that never
      // reports.
      process.exit(0);
    }
  })();
});
