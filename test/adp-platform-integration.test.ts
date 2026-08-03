/**
 * GitHubAdapter integration test against a live, already-running
 * GitHub-API-compatible backend (e.g. ADP — see docs/pragmatic_mvp.md in the
 * adp repo, or a real GitHub Enterprise Server instance).
 *
 * This does NOT stand up a backend itself — that's a separate concern with
 * its own lifecycle (containers, migrations, TLS proxy for gh's host
 * restrictions). It only runs when the environment already points at one,
 * and is otherwise skipped. A working local setup: crib the cert + TLS proxy
 * + pinned gh + bootstrap steps from a GitHub-compatible server's own
 * acceptance harness (e.g. adp's server/acceptance/run.sh), then export:
 *
 *   GH_HOST=localhost:<tls-proxy-port>
 *   GH_ENTERPRISE_TOKEN=<bootstrapped token>
 *   SSL_CERT_FILE=<path to the proxy's self-signed cert>
 *   SQUAD_ADP_TEST_API_URL=http://localhost:<plain-http-port>
 *   SQUAD_ADP_TEST_REPO=<owner>/<repo>   (must already exist, empty is fine)
 *
 * Covers the create -> gate -> approve -> merge-once path end to end through
 * GitHubAdapter's real gh-CLI-mediated calls, asserting against squad's own
 * WorkItem/PullRequest types — not raw gh JSON. The gate/approve steps have
 * no equivalent on real GitHub and aren't part of PlatformAdapter's
 * interface, so those two steps talk to the backend's REST API directly;
 * everything else goes through GitHubAdapter.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitHubAdapter } from '../packages/squad-sdk/src/platform/github.js';

function skipReason(): string | null {
  const required = ['GH_HOST', 'GH_ENTERPRISE_TOKEN', 'SSL_CERT_FILE', 'SQUAD_ADP_TEST_API_URL', 'SQUAD_ADP_TEST_REPO'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    return `not configured against a live backend (missing ${missing.join(', ')}) — see this file's header comment`;
  }
  return null;
}

const SKIP_REASON = skipReason();

describe.skipIf(SKIP_REASON !== null)(
  `GitHubAdapter against a live GitHub-compatible backend (${SKIP_REASON ?? 'enabled'})`,
  () => {
    // Read lazily (not at describe-body eval time): describe.skipIf still
    // evaluates this body to register the suite even when skipped, so
    // anything that assumes the env vars exist must live inside a hook.
    let apiUrl: string;
    let token: string;
    let owner: string;
    let repo: string;
    let tempDir: string;
    let adapter: GitHubAdapter;

    /** Raw REST call against the backend — used only for steps GitHubAdapter has no method for. */
    async function api(method: string, path: string, body?: unknown): Promise<unknown> {
      const res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        throw new Error(`${method} ${path} -> HTTP ${res.status}: ${await res.text()}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : undefined;
    }

    function git(args: string, cwd: string): string {
      return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    }

    beforeAll(() => {
      apiUrl = process.env['SQUAD_ADP_TEST_API_URL']!;
      token = process.env['GH_ENTERPRISE_TOKEN']!;
      [owner, repo] = process.env['SQUAD_ADP_TEST_REPO']!.split('/');
      adapter = new GitHubAdapter(owner!, repo!);
      tempDir = mkdtempSync(join(tmpdir(), 'squad-adp-integration-'));

      const cloneUrl = `${apiUrl.replace(/^https?:\/\//, `http://x-access-token:${token}@`)}/${owner}/${repo}.git`;
      execSync(`git clone ${cloneUrl} clone`, { cwd: tempDir, stdio: 'ignore' });
      const clone = join(tempDir, 'clone');
      git('config user.email integration@example.com', clone);
      git('config user.name "Integration Test"', clone);

      // An empty repo has no HEAD yet — give it one so a feature branch has
      // something to fork from.
      try {
        git('checkout -B main', clone);
      } catch {
        /* already has a default branch */
      }
      writeFileSync(join(clone, 'README.md'), '# integration test fixture\n');
      git('add .', clone);
      try {
        git('commit -m "seed" ', clone);
        git('push origin HEAD:main', clone);
      } catch {
        /* main already has content — fine, branch below still forks from it */
      }
    });

    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('runs the create -> gate -> approve -> merge-once path through GitHubAdapter', async () => {
      const clone = join(tempDir, 'clone');
      const branch = `squad-integration-${Date.now()}`;

      git('fetch origin main', clone);
      git('checkout -B main origin/main', clone);
      git(`checkout -b ${branch}`, clone);
      appendFileSync(join(clone, 'README.md'), `touched by ${branch}\n`);
      git('add .', clone);
      git('commit -m "integration test change"', clone);
      git(`push origin ${branch}`, clone);
      const headSha = git('rev-parse HEAD', clone);

      // 1. create — through the real adapter.
      const pr = await adapter.createPullRequest({
        title: `Integration test ${branch}`,
        sourceBranch: branch,
        targetBranch: 'main',
        description: 'Opened by adp-platform-integration.test.ts',
      });
      expect(pr.sourceBranch).toBe(branch);
      expect(pr.targetBranch).toBe('main');
      expect(pr.status).toBe('active');

      // Confirm listPullRequests also sees it, via the adapter, before landing it.
      const openPrs = await adapter.listPullRequests({ status: 'active' });
      expect(openPrs.some((p) => p.id === pr.id)).toBe(true);

      // 2/3. gate + approve — backend-specific land-policy prerequisites with
      // no equivalent on real GitHub; not part of PlatformAdapter's surface.
      await api('POST', `/api/v3/repos/${owner}/${repo}/gates`, {
        git_sha: headSha,
        name: 'test',
        status: 'success',
        summary: 'integration test gate',
      });
      await api('POST', `/api/v3/repos/${owner}/${repo}/pulls/${pr.id}/reviews`, {
        state: 'approved',
        body: 'lgtm (integration test)',
      });

      // 4. merge-once — through the real adapter.
      await adapter.mergePullRequest(pr.id);

      const mergedPrs = await adapter.listPullRequests({ status: 'completed' });
      const merged = mergedPrs.find((p) => p.id === pr.id);
      expect(merged).toBeDefined();
      expect(merged!.status).toBe('completed');
    });
  },
);
