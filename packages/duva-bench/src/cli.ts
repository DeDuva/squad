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

options:
  --version, -v        print the package version
  --help, -h           print this message
`;

/**
 * Run one command. Pure with respect to the process: no writes, no exits.
 *
 * @param argv Arguments after the node binary and script path.
 */
export function runCli(argv: string[]): CliResult {
  const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: '' });

  if (argv.includes('--help') || argv.includes('-h')) return ok(USAGE);
  if (argv.includes('--version') || argv.includes('-v')) return ok(`${benchVersion()}\n`);

  const command = argv[0];
  if (command === undefined) return ok(USAGE);
  if (command === 'version') return ok(`${benchVersion()}\n`);

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
  const result = runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
