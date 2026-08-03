/**
 * Which label opts an issue in to autonomous execution.
 *
 * This is a safety control, not a preference: whatever this resolves to is
 * the set of issues an unattended agent may pick up and open PRs against.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecuteCapability } from '../packages/squad-cli/src/cli/commands/watch/capabilities/execute.js';
import type { WatchContext } from '../packages/squad-cli/src/cli/commands/watch/types.js';

/** Adapter that records the filter it was asked for and returns nothing. */
function recordingAdapter() {
  const calls: Array<{ tags?: string[] }> = [];
  return {
    calls,
    adapter: {
      type: 'github' as const,
      listWorkItems: async (opts: { tags?: string[] }) => {
        calls.push(opts);
        return [];
      },
    },
  };
}

function contextWith(executeLabel?: string) {
  const { calls, adapter } = recordingAdapter();
  const context = {
    teamRoot: process.cwd(),
    adapter,
    round: 1,
    roster: [{ name: 'Devon', label: 'squad:devon', expertise: [] }],
    config: {},
    ...(executeLabel ? { executeLabel } : {}),
  } as unknown as WatchContext;
  return { calls, context };
}

describe('execute capability — opt-in label', () => {
  it('defaults to "squad" so existing setups are unaffected', async () => {
    const { calls, context } = contextWith();

    await new ExecuteCapability().execute(context);

    expect(calls[0]?.tags).toEqual(['squad']);
  });

  it('honours a narrower label when one is configured', async () => {
    // Lets a repo keep `squad` as a human-triage label without every issue
    // carrying it becoming eligible for an unattended agent.
    const { calls, context } = contextWith('squad:auto');

    await new ExecuteCapability().execute(context);

    expect(calls[0]?.tags).toEqual(['squad:auto']);
  });
});

describe('execute label — reaching the executor from config.json', () => {
  it('survives the config loader', async () => {
    // The capability honouring `executeLabel` is only half of it. The loader
    // copies known keys explicitly, so a field it does not know about is
    // dropped — and, because it is also absent from the reserved set, read as
    // a capability name instead. A dry run caught exactly that: the label was
    // set in config.json and the board still came back clear.
    const { loadWatchConfig } = await import('../packages/squad-cli/src/cli/commands/watch/config.js');
    const root = mkdtempSync(join(tmpdir(), 'squad-exec-label-'));
    const squadDir = join(root, '.squad');
    mkdirSync(squadDir, { recursive: true });
    writeFileSync(join(squadDir, 'config.json'), JSON.stringify({ watch: { executeLabel: 'squad:auto' } }));

    try {
      const config = loadWatchConfig(root, {});

      expect(config.executeLabel).toBe('squad:auto');
      expect(Object.keys(config.capabilities)).not.toContain('executeLabel');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves executeLabel unset when config.json does not mention it', async () => {
    const { loadWatchConfig } = await import('../packages/squad-cli/src/cli/commands/watch/config.js');
    const root = mkdtempSync(join(tmpdir(), 'squad-exec-label-none-'));
    mkdirSync(join(root, '.squad'), { recursive: true });

    try {
      expect(loadWatchConfig(root, {}).executeLabel).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
