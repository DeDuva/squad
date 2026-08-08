/**
 * duva-bench's CLI entry, at the point where it does almost nothing.
 *
 * `--version` is the only command S0 ships, and it is not decoration: every
 * trial recorded to ADP is labelled with the bench version, so a version that
 * lies about the tree it ran from would quietly make two studies look like one.
 * That is why it is read from the manifest at call time rather than compiled
 * in — `bump-build.mjs` rewrites workspace versions during `npm run prebuild`.
 *
 * The dispatcher is tested in-process rather than by spawning `npx tsx`: the
 * repo does not vendor tsx, so a subprocess test would reach the network from
 * CI. The spawned form is exercised by hand and recorded in the PR.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCli, USAGE } from '../packages/duva-bench/src/cli.js';
import { benchVersion, packageRoot } from '../packages/duva-bench/src/version.js';

const manifestVersion = (
  JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version: string }
).version;

describe('duva-bench cli', () => {
  it('reports the version the manifest actually declares', async () => {
    expect(benchVersion()).toBe(manifestVersion);

    for (const argv of [['--version'], ['-v'], ['version']]) {
      expect(await runCli(argv)).toEqual({ code: 0, stdout: `${manifestVersion}\n`, stderr: '' });
    }
  });

  it('locates its own package root from the module URL', () => {
    expect(packageRoot().endsWith(join('packages', 'duva-bench'))).toBe(true);
  });

  it('prints usage for --help and for no arguments', async () => {
    for (const argv of [['--help'], ['-h'], []]) {
      expect(await runCli(argv)).toEqual({ code: 0, stdout: USAGE, stderr: '' });
    }
  });

  it('answers --help even when a real command is also named', async () => {
    // The async dispatcher must not reach a model to print usage.
    expect(await runCli(['harness-check', '--help'])).toEqual({ code: 0, stdout: USAGE, stderr: '' });
  });

  it('fails an unknown command with a usage exit code, not a crash', async () => {
    const result = await runCli(['bogus']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown command 'bogus'");
    expect(result.stderr).toContain(USAGE);
  });

  it('does not exit the process when imported', () => {
    // The module is already imported above; reaching this line is the assertion.
    expect(typeof runCli).toBe('function');
  });
});
