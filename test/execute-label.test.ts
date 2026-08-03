/**
 * Which label opts an issue in to autonomous execution.
 *
 * This is a safety control, not a preference: whatever this resolves to is
 * the set of issues an unattended agent may pick up and open PRs against.
 */

import { describe, it, expect } from 'vitest';
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
