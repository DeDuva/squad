/**
 * The package version, read from disk rather than compiled in.
 *
 * `bump-build.mjs` rewrites workspace versions during `npm run prebuild`, so a
 * version baked into a source constant would be stale the moment a build ran.
 * Reading the manifest keeps `--version` honest about the tree it is running
 * from — which is the only reason a bench harness reports its own version at
 * all: every recorded run is labelled with it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Absolute path to `packages/duva-bench`, wherever the tree happens to live. */
export function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** The `version` field of `packages/duva-bench/package.json`. */
export function benchVersion(): string {
  const manifest = JSON.parse(
    readFileSync(join(packageRoot(), 'package.json'), 'utf8')
  ) as { version?: string };
  if (!manifest.version) {
    throw new Error('duva-bench package.json has no version field');
  }
  return manifest.version;
}
