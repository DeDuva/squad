/**
 * `squad init` inside a git worktree.
 *
 * The guard exists to stop init scaffolding a *duplicate* `.squad/` in a
 * worktree whose main checkout already has one. It used to fire on the
 * worktree-ness alone, without asking whether this directory already had a
 * `.squad/` of its own — so in a repo that tracks `.squad/`, where every
 * worktree gets one with the branch, init never reported the directory sitting
 * in front of it and returned early instead.
 *
 * Both directions are pinned here against real worktrees, because making the
 * second case pass is easy to do by weakening the first.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Run `squad init` non-interactively and return its combined output. */
function runInit(cwd: string): { out: string; code: number } {
  try {
    const out = execFileSync('node', [CLI, 'init'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: { ...process.env, SQUAD_NO_RESOLVE_CACHE: '1' },
    });
    return { out, code: 0 };
  } catch (err: any) {
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

describe('squad init worktree guard', () => {
  let base: string;
  let main: string;
  let worktree: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'wt-guard-')));
    main = join(base, 'main');
    worktree = join(base, 'wt');
    mkdirSync(main, { recursive: true });

    git(main, ['init', '-q', '-b', 'main']);
    git(main, ['config', 'user.email', 'lab@test']);
    git(main, ['config', 'user.name', 'lab']);
    writeFileSync(join(main, 'README.md'), '# main\n');
    git(main, ['add', '-A']);
    git(main, ['commit', '-qm', 'seed']);

    // The main checkout has a .squad/, which is the precondition the guard
    // cares about.
    mkdirSync(join(main, '.squad'), { recursive: true });
    writeFileSync(join(main, '.squad', 'config.json'), '{"version":1}\n');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('still guards a worktree that has no .squad/ of its own', () => {
    git(main, ['worktree', 'add', '-q', worktree, '-b', 'feature']);

    const { out } = runInit(worktree);

    expect(out).toContain('Git worktree detected');
    expect(out).toContain(main);
    // Non-interactive defaults to sharing, and says so rather than scaffolding.
    expect(out).toContain('Using shared');
  }, 120_000);

  it('scaffolds into a worktree that already has its own .squad/, and says so on a rerun', () => {
    git(main, ['worktree', 'add', '-q', worktree, '-b', 'feature']);
    // Standing in for a repo that tracks `.squad/`: the directory arrives with
    // the branch, so the worktree has one before init ever runs.
    mkdirSync(join(worktree, '.squad'), { recursive: true });
    writeFileSync(join(worktree, '.squad', 'config.json'), '{"version":1}\n');

    // Nothing to duplicate, so nothing to ask about — init gets on with it.
    const first = runInit(worktree);
    expect(first.out).not.toContain('Git worktree detected');
    expect(first.code).toBe(0);

    // And a second pass reports what is there rather than rewriting it, which
    // is the behaviour the acceptance scenario checks against a populated repo.
    const second = runInit(worktree);
    expect(second.out).not.toContain('Git worktree detected');
    expect(second.out).toContain('already exists');
    expect(second.code).toBe(0);
  }, 120_000);

  it('leaves a plain checkout untouched by the guard', () => {
    // Not a worktree at all — the guard must not reach for a main checkout.
    runInit(main);
    const { out, code } = runInit(main);
    expect(out).not.toContain('Git worktree detected');
    expect(out).toContain('already exists');
    expect(code).toBe(0);
  }, 120_000);
});
