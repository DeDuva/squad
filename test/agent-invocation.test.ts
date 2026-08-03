/**
 * How squad invokes an agent to do work.
 *
 * These assertions are a safety boundary as much as a wiring check: the
 * allow/deny lists are what stop an unattended run from force-pushing or
 * opening a non-draft PR, so a change that quietly widens them should fail
 * a test rather than surprise someone overnight.
 */

import { describe, it, expect } from 'vitest';

import {
  resolveAgentCommand,
  parseHarnessOutput,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_DISALLOWED_TOOLS,
} from '../packages/squad-cli/src/cli/core/agent-invocation.js';

/** Read the value that follows a flag. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe('resolveAgentCommand — claude default', () => {
  it('runs the claude CLI', () => {
    expect(resolveAgentCommand('do a thing').cmd).toBe('claude');
  });

  it('puts the prompt last, after every flag', () => {
    // `-p` is `--print`, a boolean; the prompt is positional. Flags placed
    // after it would be read as part of the prompt.
    const { args } = resolveAgentCommand('do a thing');

    expect(args[args.length - 2]).toBe('-p');
    expect(args[args.length - 1]).toBe('do a thing');
  });

  it('requests JSON output so the run can be accounted for', () => {
    expect(flagValue(resolveAgentCommand('x').args, '--output-format')).toBe('json');
  });

  it('uses acceptEdits rather than skipping permissions', () => {
    const { args } = resolveAgentCommand('x');

    expect(flagValue(args, '--permission-mode')).toBe('acceptEdits');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('does not pass --max-turns, which this CLI does not accept', () => {
    expect(resolveAgentCommand('x').args).not.toContain('--max-turns');
  });

  it('passes a model through when given one', () => {
    expect(flagValue(resolveAgentCommand('x', { model: 'claude-opus-5' }).args, '--model')).toBe('claude-opus-5');
  });

  it('omits --model when none is given', () => {
    expect(resolveAgentCommand('x').args).not.toContain('--model');
  });
});

describe('resolveAgentCommand — safety boundary', () => {
  it('allows only draft PR creation', () => {
    // A bare `gh pr create` does not match this pattern, so a non-draft PR
    // cannot be opened even though `gh pr view`/`diff` are permitted.
    expect(DEFAULT_ALLOWED_TOOLS).toContain('Bash(gh pr create --draft *)');
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('Bash(gh pr *)');
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('Bash(gh pr create *)');
  });

  it('denies force pushes and destructive commands', () => {
    for (const rule of ['Bash(git push --force *)', 'Bash(git push -f *)', 'Bash(rm -rf *)', 'Bash(gh repo delete *)']) {
      expect(DEFAULT_DISALLOWED_TOOLS).toContain(rule);
    }
  });

  it('puts a space before the wildcard in every Bash rule', () => {
    // `Bash(git push *)` prefix-matches the command; `Bash(git push*)` would
    // also match `git push-anything`, silently widening the rule.
    for (const rule of [...DEFAULT_ALLOWED_TOOLS, ...DEFAULT_DISALLOWED_TOOLS]) {
      if (rule.startsWith('Bash(') && rule.includes('*')) {
        expect(rule).toMatch(/ \*\)$/);
      }
    }
  });

  it('sends both lists to the CLI', () => {
    const { args } = resolveAgentCommand('x');

    expect(flagValue(args, '--allowedTools')).toBe(DEFAULT_ALLOWED_TOOLS.join(','));
    expect(flagValue(args, '--disallowedTools')).toBe(DEFAULT_DISALLOWED_TOOLS.join(','));
  });

  it('tells the agent it is unattended and must use draft PRs off a branch', () => {
    const appended = flagValue(resolveAgentCommand('x').args, '--append-system-prompt') ?? '';

    expect(appended).toMatch(/unattended/i);
    expect(appended).toMatch(/never commit directly to main/i);
    expect(appended).toMatch(/draft/i);
  });
});

describe('resolveAgentCommand — overrides', () => {
  it('lets --agent-cmd win outright', () => {
    const { cmd, args } = resolveAgentCommand('x', { agentCmd: 'claude --permission-mode plan' });

    expect(cmd).toBe('claude');
    expect(args).toEqual(['--permission-mode', 'plan', '-p', 'x']);
  });

  it('applies none of the defaults when overridden', () => {
    // An override is a complete replacement — silently re-adding the default
    // allowlist would make a deliberately-narrowed command wider than asked.
    const { args } = resolveAgentCommand('x', { agentCmd: 'some-other-agent' });

    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--output-format');
  });

  it('keeps copilot working when explicitly selected', () => {
    const { args } = resolveAgentCommand('x', { harness: 'copilot', copilotFlags: '--yolo' });

    expect(args).toContain('--yolo');
    expect(args).not.toContain('--allowedTools');
  });
});

describe('parseHarnessOutput', () => {
  it('reads result, cost, and turn count', () => {
    const summary = parseHarnessOutput(
      JSON.stringify({ result: 'done', total_cost_usd: 0.42, num_turns: 7, is_error: false }),
    );

    expect(summary).toEqual({ result: 'done', totalCostUsd: 0.42, numTurns: 7, isError: false });
  });

  it('surfaces a harness that failed while exiting zero', () => {
    expect(parseHarnessOutput(JSON.stringify({ is_error: true, result: 'nope' }))?.isError).toBe(true);
  });

  it('returns null for prose rather than throwing', () => {
    // A harness printing text is not a reason to fail a run that already ran.
    expect(parseHarnessOutput('I did the thing.')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseHarnessOutput('{ "result": ')).toBeNull();
  });

  it('tolerates empty output', () => {
    expect(parseHarnessOutput('')).toBeNull();
  });
});
