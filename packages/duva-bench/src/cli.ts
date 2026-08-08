/**
 * duva-bench's command line.
 *
 * S0 ships only the two commands that can be true before anything else exists:
 * `--version`, which every recorded run is labelled with, and `--help`, which
 * names the commands the later milestones will fill in. The dispatcher is
 * separated from the process so tests can exercise it without a subprocess and
 * without `process.exit` tearing the runner down — the lab's own CLI learned
 * that the hard way.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { benchVersion } from './version.js';

export interface CliResult {
  /** Process exit code: 0 success, 1 failure, 2 usage error. */
  code: number;
  /** Everything the command would have written to stdout. */
  stdout: string;
  /** Everything the command would have written to stderr. */
  stderr: string;
}

export const USAGE = `duva-bench — controlled factorial experiments over coding-agent arms

usage: duva-bench <command> [options]

commands:
  version              print the package version
  harness-check        certify each arm against the 8-clause contract
                       (costs a few model calls per arm; no ADP)
  validate             check a study spec and report every problem at once
  digest               print the study digest, arm digests and prereg readings
  goal                 file a goal issue, minting the intent runs hang off
  trial                run exactly one trial against an existing intent
  study                run every remaining trial of a study, resumably
  report               read a finished study back out of ADP and render it

options:
  --version, -v        print the package version
  --help, -h           print this message
  --provider=<name>    harness-check: providers to certify (comma-separated,
                       default anthropic,gemini)
  --file=<path>        validate/digest: the study spec (YAML or JSON)
`;

/**
 * Run one command. Pure with respect to the process: no writes, no exits.
 *
 * Async because everything after `version` reaches a model or ADP, and a
 * dispatcher that had to grow a second, parallel async path would be the kind
 * of split where one half quietly stops handling `--help`.
 *
 * @param argv Arguments after the node binary and script path.
 */
export async function runCli(argv: string[]): Promise<CliResult> {
  const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: '' });

  if (argv.includes('--help') || argv.includes('-h')) return ok(USAGE);
  if (argv.includes('--version') || argv.includes('-v')) return ok(`${benchVersion()}\n`);

  const command = argv[0];
  if (command === undefined) return ok(USAGE);
  if (command === 'version') return ok(`${benchVersion()}\n`);

  if (command === 'harness-check') {
    const flag = argv.find((a) => a.startsWith('--provider='));
    const providers = (flag ? flag.slice('--provider='.length).split(',') : ['anthropic', 'gemini'])
      .map((p) => p.trim())
      .filter(Boolean) as Array<'anthropic' | 'gemini'>;

    const { runHarnessCheck } = await import('./harness-check.js');
    const result = await runHarnessCheck(providers, process.cwd());
    return { code: result.failed === 0 ? 0 : 1, stdout: result.output, stderr: '' };
  }

  if (command === 'validate' || command === 'digest') {
    const flag = argv.find((a) => a.startsWith('--file='));
    if (!flag) {
      return { code: 2, stdout: '', stderr: `duva-bench ${command}: missing required --file=\n` };
    }
    const { describeStudyFile } = await import('./study-report.js');
    return describeStudyFile(flag.slice('--file='.length), command);
  }

  if (command === 'report') {
    try {
      const { runReportCommand } = await import('./live.js');
      const { report, code } = await runReportCommand({ argv, env: process.env });
      return { code, stdout: report, stderr: '' };
    } catch (error) {
      return {
        code: 2,
        stdout: '',
        stderr: `duva-bench report: ${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
  }

  if (command === 'study') {
    try {
      const { runStudyCommand } = await import('./live.js');
      const { report, code } = await runStudyCommand({ argv, env: process.env });
      return { code, stdout: report, stderr: '' };
    } catch (error) {
      return {
        code: 2,
        stdout: '',
        stderr: `duva-bench study: ${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
  }

  if (command === 'goal' || command === 'trial') {
    const io = { argv, env: process.env };
    try {
      if (command === 'goal') {
        const { mintGoal } = await import('./live.js');
        return ok(await mintGoal(io));
      }
      const { runTrialCommand } = await import('./live.js');
      const { result, report } = await runTrialCommand(io);
      // A trial that ran but did not verify is a failure of the gate, not of
      // the command — reported as a non-zero exit so a scheduler notices.
      return { code: result.verified === true ? 0 : 1, stdout: report, stderr: '' };
    } catch (error) {
      return {
        code: 2,
        stdout: '',
        stderr: `duva-bench ${command}: ${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
  }

  return {
    code: 2,
    stdout: '',
    stderr: `duva-bench: unknown command '${command}'\n\n${USAGE}`,
  };
}

/** True when this module is the process entry point rather than an import. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  runCli(process.argv.slice(2))
    .then((result) => {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.code);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}
