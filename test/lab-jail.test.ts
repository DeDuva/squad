/**
 * The work-repo jail.
 *
 * Squad has no sandbox, so a registered tool's own path check is the whole of
 * the containment. The symlink case is the one worth being explicit about: a
 * plain `resolve()` passes it, because the escape only appears once the link is
 * followed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safePath, PathEscapeError } from '../packages/squad-lab/src/tools/jail.js';

describe('safePath', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'jail-')));
    root = join(base, 'work');
    outside = join(base, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'not yours');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('resolves a path that does not exist yet, which is the write case', () => {
    expect(safePath(root, 'src/duration.js')).toBe(join(root, 'src/duration.js'));
  });

  it('resolves an existing file', () => {
    writeFileSync(join(root, 'a.js'), '');
    expect(safePath(root, 'a.js')).toBe(join(root, 'a.js'));
  });

  it('rejects traversal out of the repo', () => {
    expect(() => safePath(root, '../outside/secret.txt')).toThrow(PathEscapeError);
    expect(() => safePath(root, 'a/../../outside/secret.txt')).toThrow(PathEscapeError);
  });

  it('rejects an absolute path outside the repo', () => {
    expect(() => safePath(root, join(outside, 'secret.txt'))).toThrow(PathEscapeError);
  });

  it('rejects the repo root itself, which is not a file to write', () => {
    expect(() => safePath(root, '.')).toThrow(PathEscapeError);
  });

  it('rejects a symlink pointing out of the repo', () => {
    symlinkSync(outside, join(root, 'escape'));
    expect(() => safePath(root, 'escape/secret.txt')).toThrow(PathEscapeError);
  });

  it('allows a symlink that stays inside the repo', () => {
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real/file.txt'), 'mine');
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(safePath(root, 'link/file.txt')).toBe(join(root, 'real/file.txt'));
  });

  it('accepts an absolute path that is inside the repo', () => {
    expect(safePath(root, join(root, 'src/x.js'))).toBe(join(root, 'src/x.js'));
  });
});
