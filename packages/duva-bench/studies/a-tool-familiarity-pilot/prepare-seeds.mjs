/**
 * Materialise each task's seed as a real git repository.
 *
 * The example seeds live as plain files because a git repository cannot be
 * nested inside another one usefully, and a trial *clones* its seed — so the
 * spec points at `.seeds/<task>` and this builds them. Kept out of the spec so
 * the study's paths stay relative, which is what keeps its digest the same on
 * every machine.
 *
 *   node prepare-seeds.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const examples = resolve(here, '..', '..', '..', 'squad-lab', 'examples');
const target = join(here, '.seeds');

mkdirSync(target, { recursive: true });
for (const task of ['retry', 'semver']) {
  const out = join(target, task);
  execFileSync('node', [join(examples, task, 'make-seed.mjs'), out], { stdio: 'inherit' });
  console.log(`  ${task} -> ${out}`);
}
