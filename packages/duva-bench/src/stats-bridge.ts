/**
 * The statistics bridge: duva-bench asks, adp-replay answers.
 *
 * Both tracks of duva-bench run the same tests through the same library, so a
 * disagreement between the squad track and the Harbor track can only be about
 * the data. If each track carried its own implementation, a divergence would be
 * uninterpretable — you could not tell whether the platforms disagreed or the
 * statistics did — and the pair of tracks is itself an experiment, so that
 * ambiguity would be fatal to the point of running both.
 *
 * It is a subprocess rather than a port because the library is Python and the
 * venv already exists. No install step, no dependency added here: the path is
 * configurable and the failure when it is absent says exactly what is missing.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** Per arm, per task, one boolean per repetition. */
export type ArmOutcomes = Record<string, Record<string, boolean[]>>;

export interface StatsRequest {
  axis: string;
  baseline?: string;
  arms: ArmOutcomes;
  /** Seeded, so the same input twice gives the same output. */
  seed?: number;
  resamples?: number;
  confidence?: number;
}

export interface ArmStat {
  arm: string;
  n_tasks: number;
  n_trials?: number;
  rate: number | null;
  ci: [number, number] | null;
  icc: number | null;
}

export interface PairStat {
  baseline: string;
  arm: string;
  shared_tasks: number;
  dropped_tasks: number;
  difference: number;
  ci: [number, number];
  p_value: number;
  p_value_holm: number;
  holm_rank: number;
  discordant: { baseline_only: number; arm_only: number };
}

export interface StatsResult {
  axis: string | null;
  baseline: string | null;
  seed: number;
  resamples: number;
  confidence: number;
  arms: ArmStat[];
  pairs: PairStat[];
}

/** The interpreter that already has the library. Overridable, never installed. */
export function pythonPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DUVA_BENCH_PYTHON ?? join(homedir(), 'dev', 'adp-replay', '.venv', 'bin', 'python');
}

export function bridgeScript(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'tools', 'paired_stats.py');
}

export class StatsBridgeUnavailable extends Error {}

/**
 * Run the paired statistics.
 *
 * Throws `StatsBridgeUnavailable` rather than returning empty results when the
 * interpreter is missing: a report that silently omitted its statistics would
 * look like a study that found nothing.
 */
export async function pairedStats(request: StatsRequest): Promise<StatsResult> {
  const python = pythonPath();
  if (!existsSync(python)) {
    throw new StatsBridgeUnavailable(
      `no Python interpreter at ${python} — set DUVA_BENCH_PYTHON to one with adp_replay on its path`,
    );
  }

  const payload = JSON.stringify({ seed: 0, resamples: 10_000, confidence: 0.95, ...request });

  return new Promise<StatsResult>((resolvePromise, reject) => {
    const child = spawn(python, [bridgeScript()], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (error) => reject(new StatsBridgeUnavailable(error.message)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`paired_stats.py exited ${code}: ${err.trim() || '(no stderr)'}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(out) as StatsResult);
      } catch (error) {
        reject(new Error(`paired_stats.py produced unparseable output: ${String(error)}`));
      }
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}
