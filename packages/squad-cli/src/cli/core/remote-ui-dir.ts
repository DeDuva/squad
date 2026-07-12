/**
 * Resolve the built PWA static assets directory ("remote-ui") served by
 * `squad rc` and `squad start`.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * squad-cli's own build copies src/remote-ui/ to dist/remote-ui/ (postbuild
 * step), so the target is always "whatever dist/ actually is" — but that
 * directory sits at a different depth relative to this module depending on
 * whether squad-cli runs unbundled (dist/cli/commands/rc.js, 2 levels above
 * dist) or as squad-cli's single-file bundle (dist/squad.js, 0 levels above
 * dist, since bundling collapses every module's import.meta.url to the
 * bundle's own location). Try both.
 */
export function resolveRemoteUiDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../remote-ui'),
    path.resolve(here, 'remote-ui'),
  ];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}
