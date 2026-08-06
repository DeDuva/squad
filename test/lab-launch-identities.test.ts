/**
 * The launch guard, which is the cheapest place this can fail.
 *
 * An experiment with a grader and no second identity will run every variant,
 * spend real money on real models, and then either post nothing or post scores
 * that are self-reports. Both failures are silent in a summary table. So the
 * check happens before the first child is forked, and it stops the launch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  launchExperiment,
  labRoot,
  saveExperiment,
  type Experiment,
} from '../packages/squad-lab/src/experiments.js';
import { SameIdentityError } from '../packages/squad-lab/src/grader.js';

let home: string;
let realFetch: typeof fetch;

const experiment = (grader: Experiment['grader']): Experiment => ({
  id: 'exp_guard',
  createdAt: new Date().toISOString(),
  status: 'draft',
  goal: { title: 'parse a duration', body: '' },
  adp: {
    url: 'http://adp.test',
    owner: 'lab',
    repo: 'bake',
    issueNumber: 1,
    intentId: 'intent_1',
    tokenEnv: 'SQUAD_LAB_ADP_TOKEN',
  },
  seed: { repoUrl: '/nonexistent-seed' },
  ...(grader ? { grader } : {}),
  agents: [],
  routing: [],
  registeredTools: [],
  variants: [{ id: 'anthropic', provider: 'anthropic', externalRef: 'exp_guard:anthropic' }],
});

/** Every principal this ADP knows, keyed by token. */
function fetchAs(logins: Record<string, string>): typeof fetch {
  return (async (url: string, init: { headers?: Record<string, string> }) => {
    const token = (init.headers?.['Authorization'] ?? '').replace('Bearer ', '');
    if (!String(url).endsWith('/api/v3/user')) throw new Error(`unexpected call to ${url}`);
    return new Response(JSON.stringify({ login: logins[token] ?? 'unknown' }), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lab-guard-'));
  process.env['SQUAD_LAB_HOME'] = home;
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['SQUAD_LAB_HOME'];
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('launchExperiment identity guard', () => {
  it('refuses to launch a graded experiment with no eval identity', async () => {
    const exp = experiment({ path: '/graders/duration.mjs', sha256: 'a'.repeat(64) });
    saveExperiment(exp);

    await expect(launchExperiment(exp, { token: 'runner-token' })).rejects.toThrow(
      /grader but no eval token/,
    );
    // Nothing started: the experiment is still a draft on disk and no variant
    // directory was materialised.
    expect(existsSync(join(labRoot(), 'experiments', exp.id, 'variants'))).toBe(false);
  });

  it('refuses to launch when both tokens resolve to the same login', async () => {
    globalThis.fetch = fetchAs({ 'runner-token': 'squad-lab', 'eval-token': 'squad-lab' });
    const exp = experiment({ path: '/graders/duration.mjs', sha256: 'a'.repeat(64) });
    saveExperiment(exp);

    await expect(
      launchExperiment(exp, { token: 'runner-token', evalToken: 'eval-token' }),
    ).rejects.toThrow(SameIdentityError);
  });

  it('leaves an ungraded experiment alone — no grader, no eval identity needed', async () => {
    // The guard exists to protect scoring, not to make scoring mandatory.
    const exp = experiment(undefined);
    saveExperiment(exp);
    globalThis.fetch = fetchAs({});

    // It gets past the guard and fails later, on the workspace it has no seed
    // for — which is the point: the identity check was not what stopped it.
    await expect(launchExperiment(exp, { token: 'runner-token' })).rejects.not.toThrow(
      SameIdentityError,
    );
  });
});
