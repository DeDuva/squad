/**
 * Materialise the ledger seed as a git repository.
 *
 * The seed lives in `seed/` as plain files because a git repository cannot be
 * nested inside another one in a useful way. The lab clones its seed, so it
 * needs a real repository with at least one commit — this builds one.
 *
 *   node make-seed.mjs /tmp/importer-seed
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.argv[2] ?? join(here, '.seed'));

if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(here, 'seed'), target, { recursive: true });

// `credential.helper=` because the inherited one errors under WSL, and this
// runs in the same environments the lab does.
const git = (...args) =>
  execFileSync('git', ['-c', 'credential.helper=', ...args], { cwd: target, encoding: 'utf8' });

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'lab@example.invalid');
git('config', 'user.name', 'squad-lab');
git('add', '-A');
git('commit', '-q', '-m', 'ledger: initial');

console.log(target);
