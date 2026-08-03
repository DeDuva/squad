/**
 * Shared agent spawn utilities for watch capabilities.
 *
 * Centralises `buildAgentCommand()` and `spawnWithTimeout()` so every
 * capability uses the same logic, respects `agentCmd` from config,
 * and works on Windows (shell: true when win32).
 *
 * @see https://github.com/bradygaster/squad/issues/920
 * @see https://github.com/bradygaster/squad/issues/923
 */

import { execFile } from 'node:child_process';
import { resolveAgentCommand, resolveCopilotCmd, _resetHarnessDetection } from '../../core/agent-invocation.js';
import type { WatchContext } from './types.js';

/** True when running on Windows — used to gate `shell: true`. */
export const IS_WINDOWS = process.platform === 'win32';

/**
 * Escape an argument for safe use with cmd.exe when `shell: true`.
 *
 * Node's `execFile` with `shell: true` on Windows concatenates args with
 * spaces but does NOT quote them (Node DEP0190). This means multi-word
 * prompts get split by cmd.exe and the child process receives garbage argv.
 *
 * This function wraps any arg containing spaces, quotes, or cmd.exe
 * metacharacters in double quotes with internal double quotes escaped.
 *
 * On non-Windows (shell: false path), args are passed directly to execvp
 * without shell interpretation, so no escaping is needed.
 */
export function escapeForCmd(arg: string): string {
  // Characters that require quoting in cmd.exe
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg;
  // Escape internal double quotes by doubling them (cmd.exe convention)
  const escaped = arg.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Escape an array of args for cmd.exe shell invocation.
 * Only applies on Windows — returns args unchanged on other platforms.
 */
export function escapeArgs(args: string[]): string[] {
  if (!IS_WINDOWS) return args;
  return args.map(escapeForCmd);
}

/**
 * Copilot detection now lives in `cli/core/agent-invocation`. Re-exported
 * here so existing importers keep working.
 */
export { resolveCopilotCmd };

/** @internal */
export const _resetCopilotDetection = _resetHarnessDetection;

/**
 * Build the command + args array for an agent invocation.
 *
 * Resolution order:
 *   1. `context.agentCmd` (explicit override from config / CLI)
 *   2. Runtime detection via `resolveCopilotCmd()`:
 *      - standalone `copilot` if available on PATH
 *      - `gh copilot` as fallback
 */
export function buildAgentCommand(
  prompt: string,
  context: WatchContext,
): { cmd: string; args: string[] } {
  return resolveAgentCommand(prompt, {
    ...(context.agentCmd ? { agentCmd: context.agentCmd } : {}),
    ...(context.copilotFlags ? { copilotFlags: context.copilotFlags } : {}),
  });
}

/**
 * Spawn an agent command with a timeout.
 *
 * Uses `shell: true` on Windows so that `.cmd`/`.bat` wrappers and
 * PATH resolution work correctly.  Args are escaped via `escapeArgs()`
 * to prevent Node DEP0190 and cmd.exe metacharacter injection.
 */
export function spawnWithTimeout(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  const safeArgs = escapeArgs(args);
  return new Promise<void>((resolve, reject) => {
    execFile(cmd, safeArgs, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
      shell: IS_WINDOWS,
    }, (err) => {
      if (err) {
        const execErr = err as Error & { killed?: boolean };
        reject(new Error(
          execErr.killed
            ? `Timed out after ${Math.round(timeoutMs / 1000)}s`
            : execErr.message,
        ));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Spawn an agent command with a timeout, resolving with success/error
 * instead of rejecting.  Used by execute and wave-dispatch where the
 * caller wants to handle failure without try/catch.
 */
export function spawnAgent(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ success: boolean; error?: string }> {
  const safeArgs = escapeArgs(args);
  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    execFile(
      cmd,
      safeArgs,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 50 * 1024 * 1024,
        shell: IS_WINDOWS,
      },
      (err) => {
        if (err) {
          const execErr = err as Error & { killed?: boolean };
          const msg = execErr.killed ? 'Timed out' : execErr.message;
          resolve({ success: false, error: msg });
        } else {
          resolve({ success: true });
        }
      },
    );
  });
}
