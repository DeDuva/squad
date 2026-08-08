/**
 * The forked half of a trial.
 *
 * It exists so a trial's environment, working directory and lifetime belong to
 * it alone: API keys and the `claude` credential chain are read per-process,
 * `session.abort()` is only cooperative so a wedged backend needs a real kill,
 * and a trial that dies must not take its siblings' runs with it.
 *
 * It is deliberately thin. Everything it does is `runTrialCommand`, the same
 * path `duva-bench trial` takes from a shell — so a trial the scheduler ran and
 * a trial a human ran by hand are the same trial, and reproducing one from the
 * command line in `progress.jsonl` is a copy and paste rather than an
 * approximation.
 */

import { runTrialCommand } from './live.js';
import type { TrialChildMessage } from './scheduler.js';

function send(message: TrialChildMessage): void {
  process.send?.(message);
}

void (async () => {
  try {
    const { result } = await runTrialCommand({ argv: process.argv.slice(2), env: process.env });
    send({ t: 'result', result });
    // Exit explicitly: an open ADP client or a lingering backend handle would
    // otherwise keep the child alive after its work is reported, and a pool
    // that never reclaims a worker stalls the whole study.
    process.exit(0);
  } catch (error) {
    send({ t: 'error', message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
})();
