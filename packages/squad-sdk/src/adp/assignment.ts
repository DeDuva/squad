/**
 * Recording an assignment, from the point one begins to the sha it produced.
 *
 * This is the seam between "Squad is doing work" and "ADP holds a run". It is a
 * separate module from the recorder because the recorder does not get to decide
 * whether recording happens — that comes from configuration, and the answer is
 * usually no. Absent an `adp` block in `.squad/config.json`, or absent the token
 * it names, `startAssignmentRecording` returns `undefined` and every caller
 * carries on unchanged. Recording is an opt-in that costs nothing when it is
 * off.
 *
 * **What is recorded is what was observable.** The trajectory holds messages,
 * model calls with their token and cost accounting, tool executions, handoffs,
 * commits, and test results — the execution, not the deliberation. Hidden
 * chain-of-thought is deliberately not recorded, and no code path here reaches
 * for it.
 *
 * @module adp/assignment
 */

import { join } from 'node:path';
import type { EventBus } from '../runtime/event-bus.js';
import { resolveAdpClient } from './config.js';
import { AdpRunRecorder } from './recorder.js';

export interface StartAssignmentRecordingOptions {
  /** Repo root holding `.squad/config.json`; also where the spool is written. */
  repoRoot: string;
  bus: EventBus;
  /**
   * Squad's stable id for this assignment, e.g. `issue:42`. Makes opening the
   * run idempotent, so a restarted process rejoins the run it already opened
   * instead of forking the trajectory into two halves that each look complete.
   */
  externalRef: string;
  /**
   * The intent this assignment is against. Supply it, or supply `issueNumber`
   * and it is looked up — ADP mints an intent per issue, so the goal already
   * exists and inventing a second one would score work against the wrong thing.
   */
  intentId?: string;
  issueNumber?: number;
  /** Recording failures land here. They are never allowed to fail the work. */
  onError?: (error: Error, context: string) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * Open the run and start recording, or return `undefined` if this checkout is
 * not configured to record.
 *
 * Failures resolve to `undefined` rather than throwing, after reporting through
 * `onError`: an unreachable ADP server is a reason to lose the trace, never a
 * reason to lose the assignment.
 */
export async function startAssignmentRecording(
  options: StartAssignmentRecordingOptions,
): Promise<AdpRunRecorder | undefined> {
  const resolved = resolveAdpClient(options.repoRoot, options.env);
  if (!resolved) return undefined;

  try {
    const intentId =
      options.intentId ??
      (options.issueNumber !== undefined ? await resolved.client.getIssueIntentId(options.issueNumber) : undefined);
    if (!intentId) {
      throw new Error(
        `no intent for assignment ${options.externalRef} — pass intentId, or an issueNumber ADP knows about`,
      );
    }

    const recorder = new AdpRunRecorder({
      client: resolved.client,
      intentId,
      externalRef: options.externalRef,
      spoolRoot: join(options.repoRoot, '.squad', 'spool'),
      onError: options.onError,
    });
    await recorder.start(options.bus);
    return recorder;
  } catch (error) {
    options.onError?.(error instanceof Error ? error : new Error(String(error)), 'starting ADP recording');
    return undefined;
  }
}

/**
 * Finish a recording: close against the commit the assignment produced, or
 * abandon it when it produced none.
 *
 * The distinction is load-bearing rather than tidy. A run closes against a sha
 * ADP resolves in the repository, and closing "against nothing" would make the
 * attestation a statement about no particular state. An assignment that
 * committed nothing is a real outcome — abandon says so, and keeps the
 * trajectory, which is exactly the run someone will want to read.
 */
export async function finishAssignmentRecording(
  recorder: AdpRunRecorder | undefined,
  outcome: { finalGitSha?: string | null; reason?: string },
  onError?: (error: Error, context: string) => void,
): Promise<void> {
  if (!recorder) return;
  try {
    if (outcome.finalGitSha) await recorder.close(outcome.finalGitSha);
    else await recorder.abandon(outcome.reason ?? 'assignment produced no commit');
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)), 'finishing ADP recording');
  }
}
