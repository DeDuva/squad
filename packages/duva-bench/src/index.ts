/**
 * duva-bench, squad track.
 *
 * Defines experiments as a content-digested spec, executes each trial as an
 * in-process arm recorded to ADP, and analyzes the result against a measured
 * noise floor. This barrel is the package's only public surface; the milestones
 * add to it in order (runner, study, twins, scheduler, analysis, web).
 *
 * The one rule that outlives every milestone: what this package may import is
 * fenced by `test/lab-duvabench-boundary.test.ts`. The fence is not hygiene —
 * it is what keeps extraction to a standalone repo mechanical, and it is why
 * `SquadCoordinator` may appear in exactly one file.
 */

export { runCli, USAGE } from './cli.js';
export type { CliResult } from './cli.js';
export { benchVersion, packageRoot } from './version.js';
