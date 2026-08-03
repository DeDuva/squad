/**
 * User-friendly error message templates with recovery guidance.
 * All messages are conversational and action-oriented.
 *
 * @module cli/shell/error-messages
 */

export interface ErrorGuidance {
  message: string;
  recovery: string[];
}

/** Returns true when an error message indicates a missing or invalid Gemini API key. */
export function isGeminiAuthError(message: string): boolean {
  return /GEMINI_API_KEY.*not set|auth.*setup|api.?key.*not.*set|not.*set.*api.?key/i.test(message)
    || /Gemini.*authentication failed|authentication failed.*Gemini/i.test(message)
    || /Gemini API.*returned 40[13]/i.test(message);
}

/**
 * Returns true when an error indicates an Anthropic credential problem.
 *
 * Phrasings come from the Agent SDK and the `claude` CLI it wraps, which
 * report auth failures in their own words rather than squad's.
 */
export function isAnthropicAuthError(message: string): boolean {
  return /invalid.*api.?key|authentication_error/i.test(message)
    || /please run\s*\/login|not logged in|no credentials/i.test(message)
    || /credit balance is too low|insufficient credit/i.test(message)
    || /oauth token.*expired|token.*has expired/i.test(message);
}

/** Returns true when an error indicates a credential problem on any backend. */
export function isAuthError(message: string): boolean {
  return isGeminiAuthError(message) || isAnthropicAuthError(message);
}

/**
 * Guidance for an Anthropic credential problem.
 *
 * squad stores no Anthropic credential of its own — the SDK inherits
 * whatever the local `claude` CLI is signed in with — so the recovery is to
 * fix that, not to hand squad a key.
 */
export function anthropicAuthGuidance(): ErrorGuidance {
  return {
    message: 'Anthropic credentials are missing or invalid. Squad uses whatever your local `claude` CLI is signed in with.',
    recovery: [
      'Run: claude  (then /login) to sign in',
      'Or set env var: export ANTHROPIC_API_KEY=YOUR_KEY',
      "Then run: squad doctor  to verify",
      'To use Gemini instead: squad config provider gemini',
    ],
  };
}

/**
 * Guidance for a credential problem, picked to match the active backend.
 *
 * Showing Gemini instructions to someone on Anthropic (the default) sends
 * them to get a key they don't need and can't use.
 */
export function authGuidance(provider: 'anthropic' | 'gemini'): ErrorGuidance {
  return provider === 'anthropic' ? anthropicAuthGuidance() : missingApiKeyGuidance();
}

/** Gemini API key missing or invalid */
export function missingApiKeyGuidance(): ErrorGuidance {
  return {
    message: 'Gemini API key is not configured. Squad needs a key to run agents.',
    recovery: [
      "Run: squad auth setup --provider=gemini --key YOUR_KEY",
      "Or set env var: export GEMINI_API_KEY=YOUR_KEY",
      "Get a free key at: https://aistudio.google.com/app/apikey",
      "Then run: squad auth status  to verify",
    ],
  };
}

/** SDK disconnect / connection errors */
export function sdkDisconnectGuidance(detail?: string): ErrorGuidance {
  return {
    message: detail ? `SDK disconnected: ${detail}` : 'SDK disconnected.',
    recovery: [
      "Run 'squad doctor' to check your setup",
      'Check your internet connection',
      'Restart the shell to reconnect',
    ],
  };
}

/** team.md missing or invalid */
export function teamConfigGuidance(issue: string): ErrorGuidance {
  return {
    message: `Team configuration issue: ${issue}`,
    recovery: [
      "Run 'squad doctor' to diagnose",
      "Run 'squad init' to regenerate team.md",
      'Check .squad/team.md exists and has valid YAML',
    ],
  };
}

/** Agent session failure */
export function agentSessionGuidance(agentName: string, detail?: string): ErrorGuidance {
  return {
    message: `${agentName} session failed${detail ? `: ${detail}` : ''}.`,
    recovery: [
      'Try your message again (session will auto-reconnect)',
      "Run 'squad doctor' to check setup",
      `Use @${agentName} to retry directly`,
    ],
  };
}

/** Format seconds into a human-readable duration string */
function formatDuration(seconds: number): string {
  const hours = Math.ceil(seconds / 3600);
  const minutes = Math.ceil(seconds / 60);
  if (seconds >= 3600) return `${hours} hour${hours === 1 ? '' : 's'}`;
  if (seconds >= 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

/**
 * Extract retry-after duration (in seconds) from an error message string.
 * Handles patterns like "retry after 120 seconds", "try again in 2 hours", etc.
 */
export function extractRetryAfter(message: string): number | undefined {
  const secMatch = message.match(/retry.{0,15}after\s+(\d+)\s*second/i);
  if (secMatch) return parseInt(secMatch[1]!, 10);
  // Gemini format: "Please retry in 58.65464692s."
  const geminiSecMatch = message.match(/retry\s+in\s+(\d+(?:\.\d+)?)s/i);
  if (geminiSecMatch) return Math.ceil(parseFloat(geminiSecMatch[1]!));
  const hrMatch = message.match(/(?:try again|retry).{0,20}in\s+(\d+)\s*hour/i);
  if (hrMatch) return parseInt(hrMatch[1]!, 10) * 3600;
  const minMatch = message.match(/(?:try again|retry).{0,20}in\s+(\d+)\s*minute/i);
  if (minMatch) return parseInt(minMatch[1]!, 10) * 60;
  return undefined;
}

/** Rate limit hit — model or endpoint temporarily throttled */
export function rateLimitGuidance(opts?: { retryAfter?: number; model?: string }): ErrorGuidance {
  const modelStr = opts?.model ? ` for ${opts.model}` : '';
  const retryStr = opts?.retryAfter
    ? `Try again in ${formatDuration(opts.retryAfter)}`
    : 'Try again later when the limit resets';
  return {
    message: `Rate limit reached${modelStr}. The Gemini free tier allows 20 requests/day per model.`,
    recovery: [
      retryStr,
      'Enable economy mode to reduce requests: `squad economy on`',
      'Upgrade to a paid Gemini API key at: https://aistudio.google.com/app/apikey',
    ],
  };
}

/** Generic error with context */
export function genericGuidance(detail: string): ErrorGuidance {
  return {
    message: detail,
    recovery: [
      'Try your message again',
      "Run 'squad doctor' for diagnostics",
      'Check your internet connection',
    ],
  };
}

/** Request timeout */
export function timeoutGuidance(agentName?: string): ErrorGuidance {
  const who = agentName ? `${agentName} timed out` : 'Request timed out';
  return {
    message: `${who}. The model may be under load.`,
    recovery: [
      'Try again — the issue is often transient',
      'Set SQUAD_REPL_TIMEOUT=120 for a longer timeout (seconds)',
      "Run 'squad doctor' to verify connectivity",
    ],
  };
}

/** Unknown slash command */
export function unknownCommandGuidance(command: string): ErrorGuidance {
  return {
    message: `Unknown command: /${command}`,
    recovery: [
      'Type /help to see available commands',
      'Check for typos in the command name',
    ],
  };
}

/** Format an ErrorGuidance into a user-facing string */
export function formatGuidance(g: ErrorGuidance): string {
  const lines = [`❌ ${g.message}`];
  if (g.recovery.length > 0) {
    lines.push('   Try:');
    for (const r of g.recovery) {
      lines.push(`   • ${r}`);
    }
  }
  return lines.join('\n');
}
