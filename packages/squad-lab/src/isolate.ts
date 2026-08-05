/**
 * One work repo per variant.
 *
 * A fresh clone, not a git worktree: worktrees share `.git/config`, the object
 * store and the per-repo index lock, and two agents running `git add`
 * concurrently in linked worktrees is the class of failure that stays invisible
 * until it corrupts a run. `--no-hardlinks` so an agent-driven `git gc` in one
 * clone cannot reach into another's objects.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AdpWiring {
  url: string;
  /** `owner/name`, as `.squad/config.json` wants it. */
  repo: string;
  /** The *name* of the env var holding the token — never the token. */
  tokenEnv: string;
}

export interface WorkspaceSpec {
  /** Where the clone goes. Created if missing. */
  workDir: string;
  /** Clone source: a path or URL. Supplies the starting tree only. */
  seedRepo: string;
  /** Branch to check out for this variant's work. */
  branch: string;
  /** Ref in the seed to start from. Defaults to the seed's HEAD. */
  seedRef?: string;
  /**
   * Where the variant pushes — ADP's own git endpoint.
   *
   * This has to be ADP and not the seed. Closing a run resolves the final sha
   * *in ADP's repository*, so a variant that pushes anywhere else produces a
   * commit ADP has never heard of and a run that cannot be closed against it.
   * Omit only when nothing will be pushed.
   */
  pushRemote?: string;
  adp: AdpWiring;
}

export interface Workspace {
  workDir: string;
  branch: string;
  /** The clone's `origin`, which is where a variant pushes. */
  remote: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Clone the seed, cut the variant's branch, and write the ADP wiring.
 *
 * The `.squad/config.json` written here holds **only** the `adp` block. Not the
 * provider and not the model: `resolveProvider` returns an explicitly-passed
 * provider before it ever reads this file, so passing it at construction keeps
 * the read-modify-write in `config/models.ts` out of the picture entirely. Two
 * variants racing on a shared config file is a hazard best removed by not
 * writing, rather than by locking.
 */
export function prepareWorkspace(spec: WorkspaceSpec): Workspace {
  mkdirSync(spec.workDir, { recursive: true });

  execFileSync('git', ['clone', '--no-hardlinks', spec.seedRepo, spec.workDir], { stdio: 'pipe' });

  if (spec.seedRef) {
    git(spec.workDir, ['checkout', '--quiet', spec.seedRef]);
  }
  // A branch per variant. Re-running a vendor against a fresh clone would
  // otherwise push a non-fast-forward onto the previous attempt's branch.
  git(spec.workDir, ['checkout', '--quiet', '-B', spec.branch]);

  // The seed gave us a starting tree; from here `origin` is ADP, because that
  // is the repository a run is closed against.
  if (spec.pushRemote) {
    git(spec.workDir, ['remote', 'set-url', 'origin', spec.pushRemote]);
  }

  // Keep the lab's own wiring out of the variant's deliverable. `.squad/` is
  // ours, not the agents' work, and `commitAndPush` stages everything — so
  // without this the ADP config lands in the commit the run is closed against
  // and the grader scores a tree the agents did not produce. `info/exclude`
  // rather than `.gitignore` because the seed's tracked files are not ours to
  // edit, and the exclusion only needs to hold in this clone.
  writeFileSync(join(spec.workDir, '.git', 'info', 'exclude'), '/.squad/\n', { flag: 'a' });

  const squadDir = join(spec.workDir, '.squad');
  mkdirSync(squadDir, { recursive: true });
  writeFileSync(
    join(squadDir, 'config.json'),
    `${JSON.stringify({ version: 1, adp: spec.adp }, null, 2)}\n`,
    'utf8',
  );

  return {
    workDir: spec.workDir,
    branch: spec.branch,
    remote: git(spec.workDir, ['remote', 'get-url', 'origin']),
  };
}

/**
 * Commit whatever the agents produced and push it.
 *
 * Returns the sha, or null when they produced nothing — which is a real
 * outcome for a variant, not an error.
 */
export function commitAndPush(workspace: Workspace, message: string): string | null {
  git(workspace.workDir, ['add', '-A']);
  if (git(workspace.workDir, ['status', '--porcelain']).length === 0) return null;

  git(workspace.workDir, ['commit', '--quiet', '-m', message]);
  // `-c credential.helper=` clears the inherited list before anything else runs:
  // git consults *every* configured helper, and under WSL the Windows credential
  // manager errors out even when the remote URL already carries a token.
  execFileSync(
    'git',
    ['-c', 'credential.helper=', 'push', '--quiet', 'origin', `HEAD:${workspace.branch}`],
    { cwd: workspace.workDir, stdio: 'pipe' },
  );
  return git(workspace.workDir, ['rev-parse', 'HEAD']);
}
