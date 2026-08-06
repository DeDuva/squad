/**
 * Keeping an agent's file tools inside the work repo.
 *
 * Squad has no sandbox: `SquadSessionConfig.workingDirectory` scopes a
 * backend's *built-in* tools, and tools we register ourselves get whatever path
 * the model asks for. So the jail has to live in the tool, and every registered
 * tool has to route through it — a tool that can write anywhere is not a tool.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class PathEscapeError extends Error {
  constructor(requested: string) {
    super(`path escapes the work repo: ${requested}`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Resolve a repo-relative path inside `root`, or throw.
 *
 * The path itself need not exist — that is the normal case for a file about to
 * be written — so the check runs against the deepest ancestor that *does*,
 * with symlinks resolved. That closes the hole a plain `resolve()` leaves: a
 * symlink planted inside the repo pointing out of it would otherwise pass,
 * because the escape only appears once the link is followed.
 */
export function safePath(root: string, requested: string): string {
  return resolveInside(root, requested, false);
}

/**
 * As `safePath`, but the repo root itself is a legitimate answer.
 *
 * A listing tool has to be able to list the repository, and `safePath` rejects
 * the root — correctly, for a tool that writes a file, and wrongly for one that
 * reads a directory. Splitting them was not academic: `list_files` shipped on
 * `safePath`, so the most natural call an agent could make — no argument at all
 * — always failed. One vendor guessed subdirectory names and carried on; the
 * other retried the empty call, gave up, and its run was recorded as the model
 * producing nothing.
 */
export function safeDir(root: string, requested: string): string {
  return resolveInside(root, requested === '' ? '.' : requested, true);
}

function resolveInside(root: string, requested: string, allowRoot: boolean): string {
  const rootReal = realpathSync(root);
  const full = resolve(rootReal, requested);

  // Deepest existing ancestor of `full`, and the part of `full` below it.
  let ancestor = full;
  const remainder: string[] = [];
  for (;;) {
    try {
      ancestor = realpathSync(ancestor);
      break;
    } catch {
      const parent = resolve(ancestor, '..');
      // Ran out of path without finding anything real — nothing to compare
      // against, so treat it as an escape rather than guessing.
      if (parent === ancestor) throw new PathEscapeError(requested);
      remainder.unshift(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      ancestor = parent;
    }
  }

  const resolved = remainder.length > 0 ? resolve(ancestor, ...remainder) : ancestor;
  const rel = relative(rootReal, resolved);
  if ((rel === '' && !allowRoot) || rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathEscapeError(requested);
  }
  return resolved;
}
