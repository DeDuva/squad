/**
 * GitHubAdapter unit tests — exercises the actual `gh` CLI invocations via a
 * mocked `execFileSync`, rather than the mock `PlatformAdapter` objects used
 * elsewhere in the test suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { GitHubAdapter } from '../packages/squad-sdk/src/platform/github.js';

const mockExec = vi.mocked(execFileSync);

describe('GitHubAdapter.createPullRequest', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('creates the PR without --json, then fetches the full record via pr view', async () => {
    mockExec.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === 'pr' && a[1] === 'create') {
        // Real `gh pr create` has no --json flag — this must not send one.
        expect(a).not.toContain('--json');
        return '/owner/repo/pulls/42\n';
      }
      if (a[0] === 'pr' && a[1] === 'view') {
        expect(a).toContain('--json');
        return JSON.stringify({
          number: 42,
          title: 'Add feature',
          headRefName: 'feature',
          baseRefName: 'main',
          state: 'OPEN',
          isDraft: false,
          reviewDecision: '',
          author: { login: 'someone' },
          url: '/owner/repo/pulls/42',
        });
      }
      throw new Error(`unexpected gh invocation: ${JSON.stringify(a)}`);
    });

    const adapter = new GitHubAdapter('owner', 'repo');
    const pr = await adapter.createPullRequest({
      title: 'Add feature',
      sourceBranch: 'feature',
      targetBranch: 'main',
    });

    expect(pr).toEqual({
      id: 42,
      title: 'Add feature',
      sourceBranch: 'feature',
      targetBranch: 'main',
      status: 'active',
      reviewStatus: undefined,
      author: 'someone',
      url: '/owner/repo/pulls/42',
    });
  });

  it('throws a clear error when the printed URL has no parseable PR number', async () => {
    mockExec.mockReturnValue('not a url' as unknown as Buffer);

    const adapter = new GitHubAdapter('owner', 'repo');
    await expect(
      adapter.createPullRequest({ title: 'T', sourceBranch: 'a', targetBranch: 'main' }),
    ).rejects.toThrow('Could not parse PR number from gh output');
  });

  it('accepts both singular and plural /pull(s)/ URL shapes', async () => {
    mockExec.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === 'pr' && a[1] === 'create') return 'https://github.com/owner/repo/pull/7\n';
      return JSON.stringify({
        number: 7, title: 'T', headRefName: 'a', baseRefName: 'main',
        state: 'OPEN', isDraft: false, reviewDecision: '',
        author: { login: 'x' }, url: 'https://github.com/owner/repo/pull/7',
      });
    });

    const adapter = new GitHubAdapter('owner', 'repo');
    const pr = await adapter.createPullRequest({ title: 'T', sourceBranch: 'a', targetBranch: 'main' });
    expect(pr.id).toBe(7);
  });
});

describe('GitHubAdapter.ensureTag', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('resolves cleanly when label create succeeds', async () => {
    mockExec.mockReturnValue('' as unknown as Buffer);
    const adapter = new GitHubAdapter('owner', 'repo');
    await expect(adapter.ensureTag('bug')).resolves.toBeUndefined();
  });

  it('propagates the error instead of silently swallowing it', async () => {
    mockExec.mockImplementation(() => {
      throw new Error('HTTP 404: Route POST:/api/v3/repos/owner/repo/labels not found');
    });
    const adapter = new GitHubAdapter('owner', 'repo');
    await expect(adapter.ensureTag('bug')).rejects.toThrow('HTTP 404');
  });
});
