/**
 * Builds the command that runs an agent to do work.
 *
 * squad had four near-identical copies of this logic, so changing the default
 * harness meant changing it in four places and hoping. This is the one place.
 *
 * @module cli/core/agent-invocation
 */

import { execFileSync } from 'node:child_process';

/** True when running on Windows — callers gate `shell: true` on it. */
export const IS_WINDOWS = process.platform === 'win32';

/** Harness squad shells out to when it needs an agent to do real work. */
export type AgentHarness = 'claude' | 'copilot';

export interface AgentCommandContext {
  /** Explicit override from `--agent-cmd` or watch config. Always wins. */
  agentCmd?: string;
  /** Extra flags for the legacy copilot harness. Ignored otherwise. */
  copilotFlags?: string;
  /** Which harness to default to when no override is given. */
  harness?: AgentHarness;
  /** Model to pass through, when the harness accepts one. */
  model?: string;
}

/**
 * Tools the agent may use by default.
 *
 * Deliberately an allowlist rather than `--dangerously-skip-permissions`.
 * `acceptEdits` covers file writes and common filesystem commands, but every
 * other shell command still needs an entry here or the run aborts when it is
 * attempted — so this list is the real boundary on what an unattended agent
 * can do.
 *
 * The space before `*` is load-bearing: `Bash(git push *)` prefix-matches the
 * `git push` command, whereas `Bash(git push*)` would also match
 * `git push-something-else`.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash(git *)',
  'Bash(gh issue *)',
  // Draft-only by construction: a non-draft `gh pr create` does not match
  // this pattern and is therefore denied.
  'Bash(gh pr create --draft *)',
  'Bash(gh pr view *)',
  'Bash(gh pr diff *)',
  'Bash(npm *)',
  'Bash(make *)',
];

/**
 * Commands denied outright, even though a broader allow rule would match.
 *
 * Deny beats allow, so these carve holes in `Bash(git *)` and friends. Each
 * is something whose damage is hard or impossible to undo from a later turn.
 */
export const DEFAULT_DISALLOWED_TOOLS = [
  'Bash(git push --force *)',
  'Bash(git push -f *)',
  'Bash(rm -rf *)',
  'Bash(gh repo delete *)',
];

/** Guardrails appended to the harness's own system prompt. */
export const DEFAULT_SYSTEM_APPEND = [
  'You are running unattended as part of an automated squad run.',
  'Never commit directly to main. Create a branch named squad/<slug> from a fresh origin/main.',
  'Open pull requests as drafts.',
  'If you cannot complete the task, say so plainly and stop rather than forcing a change through.',
].join(' ');

let cachedCopilot: { cmd: string; cmdPrefix: string[] } | null = null;

/**
 * Detect which copilot CLI is available, cached for the process lifetime.
 * Only consulted when the copilot harness is explicitly selected.
 */
export function resolveCopilotCmd(): { cmd: string; cmdPrefix: string[] } {
  if (cachedCopilot) return cachedCopilot;
  try {
    execFileSync('copilot', ['--version'], { stdio: 'ignore', timeout: 5_000, shell: IS_WINDOWS });
    cachedCopilot = { cmd: 'copilot', cmdPrefix: [] };
  } catch {
    cachedCopilot = { cmd: 'gh', cmdPrefix: ['copilot'] };
  }
  return cachedCopilot;
}

/** Reset cached detection. Testing only. @internal */
export function _resetHarnessDetection(): void {
  cachedCopilot = null;
}

/**
 * Build the command and args to run an agent on `prompt`.
 *
 * Resolution order: an explicit `agentCmd` always wins, so `--agent-cmd`
 * stays a true override and never a requirement; otherwise the configured
 * harness supplies the defaults.
 *
 * The prompt is always appended last. `-p` is `--print`, a boolean flag —
 * the prompt itself is positional — so every other flag has to precede it.
 */
export function resolveAgentCommand(
  prompt: string,
  context: AgentCommandContext = {},
): { cmd: string; args: string[] } {
  if (context.agentCmd) {
    const parts = context.agentCmd.trim().split(/\s+/);
    const cmd = parts[0]!;
    return { cmd, args: [...parts.slice(1), '-p', prompt] };
  }

  if ((context.harness ?? 'claude') === 'claude') {
    const args = [
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      DEFAULT_ALLOWED_TOOLS.join(','),
      '--disallowedTools',
      DEFAULT_DISALLOWED_TOOLS.join(','),
      '--append-system-prompt',
      DEFAULT_SYSTEM_APPEND,
    ];
    if (context.model) args.push('--model', context.model);
    args.push('-p', prompt);
    return { cmd: 'claude', args };
  }

  const { cmd, cmdPrefix } = resolveCopilotCmd();
  const args = [...cmdPrefix, '-p', prompt];
  if (context.copilotFlags) args.push(...context.copilotFlags.trim().split(/\s+/));
  return { cmd, args };
}

/** What a `--output-format json` run reports back. */
export interface HarnessRunSummary {
  result?: string;
  totalCostUsd?: number;
  numTurns?: number;
  isError?: boolean;
}

/**
 * Parse a harness run's stdout.
 *
 * squad discarded this entirely, which is why an unattended run could spend
 * real money and leave no record of what it did. Returns null rather than
 * throwing when the output isn't JSON — a harness that printed prose is not
 * a reason to fail the run that already happened.
 */
export function parseHarnessOutput(stdout: string): HarnessRunSummary | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const summary: HarnessRunSummary = {};
    if (typeof parsed['result'] === 'string') summary.result = parsed['result'];
    if (typeof parsed['total_cost_usd'] === 'number') summary.totalCostUsd = parsed['total_cost_usd'];
    if (typeof parsed['num_turns'] === 'number') summary.numTurns = parsed['num_turns'];
    if (typeof parsed['is_error'] === 'boolean') summary.isError = parsed['is_error'];
    return summary;
  } catch {
    return null;
  }
}
