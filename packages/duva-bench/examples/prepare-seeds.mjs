/**
 * Materialise each example task's seed as a real git repository.
 *
 * The example seeds live as plain files under `squad-lab/examples/<task>/seed`
 * because a git repository cannot usefully nest inside another one, and a
 * trial *clones* its seed. This builds `.seeds/<task>` next to this file —
 * gitignored, machine-local — the same fix `studies/a-tool-familiarity-pilot`
 * already applied for the same reason.
 *
 *   node prepare-seeds.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const labExamples = resolve(here, '..', '..', 'squad-lab', 'examples');
const target = join(here, '.seeds');

mkdirSync(target, { recursive: true });
for (const task of ['retry', 'semver']) {
  const out = join(target, task);
  execFileSync('node', [join(labExamples, task, 'make-seed.mjs'), out], { stdio: 'inherit' });
  console.log(`  ${task} -> ${out}`);
}
