/**
 * Regression test for getSDKTemplatesDir()'s candidate-path priority.
 *
 * squad-sdk's own dist/config/init.js resolves its templates dir relative to
 * `import.meta.url`. That assumption breaks once squad-sdk's source is
 * esbuild-bundled into squad-cli's single-file dist/squad.js (airgap build) —
 * `import.meta.url` then points at squad-cli/dist/, not squad-sdk/dist/config/,
 * so the old 2-candidate resolver silently landed on an unrelated, stale
 * templates/ directory at the monorepo root and reported a bogus skill-drift
 * error on `squad init`. This test locks in the fixed priority order.
 *
 * @module test/sdk-templates-dir-resolution
 */

import { describe, it, expect } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getSDKTemplatesDir } from '../packages/squad-sdk/src/config/init.js';
import type { StorageProvider } from '../packages/squad-sdk/src/storage/index.js';

// getSDKTemplatesDir() derives `currentDir` from its own module's
// import.meta.url, not from anything injectable — so candidate paths in
// these tests must be computed the same way the function itself does.
const currentDir = dirname(fileURLToPath(import.meta.resolve('../packages/squad-sdk/src/config/init.js')));
const distPath = join(currentDir, '../../templates');
const siblingPath = join(currentDir, '../templates');
const pkgPath = join(currentDir, '../../../templates');

function fakeStorage(existing: string[]): StorageProvider {
  const existingSet = new Set(existing);
  return {
    existsSync: (p: string) => existingSet.has(p),
  } as unknown as StorageProvider;
}

describe('getSDKTemplatesDir', () => {
  it('prefers the unbundled squad-sdk dist location when present', () => {
    const storage = fakeStorage([distPath, siblingPath, pkgPath]);
    expect(getSDKTemplatesDir(storage)).toBe(distPath);
  });

  it('falls back to the sibling-of-dist location when bundled into squad-cli', () => {
    // Simulates the airgap build: squad-sdk's source is esbuild-bundled into
    // squad-cli's single-file dist/squad.js, so squad-sdk's own dist/ location
    // (distPath) does not exist, but squad-cli ships its own synced templates
    // dir as a sibling of dist/.
    const storage = fakeStorage([siblingPath, pkgPath]);
    expect(getSDKTemplatesDir(storage)).toBe(siblingPath);
  });

  it('only falls back to the monorepo-root templates dir as a last resort', () => {
    const storage = fakeStorage([pkgPath]);
    expect(getSDKTemplatesDir(storage)).toBe(pkgPath);
  });

  it('returns null when no candidate exists', () => {
    const storage = fakeStorage([]);
    expect(getSDKTemplatesDir(storage)).toBeNull();
  });
});
