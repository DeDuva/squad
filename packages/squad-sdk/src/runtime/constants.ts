/**
 * Central constants — single source of truth for model names, timeouts, roles.
 * All magic values live here. Environment variables override where noted.
 *
 * @module runtime/constants
 */

// ============================================================================
// Models
// ============================================================================

export const MODELS = {
  /** Default model for config files and new projects (env-overridable) */
  DEFAULT: process.env['SQUAD_DEFAULT_MODEL'] ?? 'gemini-2.5-flash-preview-04-17',

  /** Default model for model-selector Layer 4 */
  SELECTOR_DEFAULT: 'gemini-2.5-flash-preview-04-17',

  /** Default tier for the model-selector Layer 4 fallback */
  SELECTOR_DEFAULT_TIER: 'standard',

  /** Fallback chains by tier — ordered by preference */
  FALLBACK_CHAINS: {
    premium: [
      'gemini-2.5-pro-preview-05-06',
      'gemini-2.5-pro',
      'gemini-2.5-flash-preview-04-17',
    ],
    standard: [
      'gemini-2.5-flash-preview-04-17',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
    ],
    fast: [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
    ],
  },

  /** Nuclear fallback model when all chains are exhausted */
  NUCLEAR_FALLBACK: 'gemini-2.0-flash',

  /** Maximum retries before nuclear fallback engages */
  NUCLEAR_MAX_RETRIES: 3,
} as const;

// ============================================================================
// Timeouts
// ============================================================================

export const TIMEOUTS = {
  /** Health check timeout in milliseconds */
  HEALTH_CHECK_MS: parseInt(process.env['SQUAD_HEALTH_CHECK_MS'] ?? '5000', 10),

  /** Git clone timeout in milliseconds */
  GIT_CLONE_MS: parseInt(process.env['SQUAD_GIT_CLONE_MS'] ?? '60000', 10),

  /** Plugin/marketplace fetch timeout in milliseconds */
  PLUGIN_FETCH_MS: parseInt(process.env['SQUAD_PLUGIN_FETCH_MS'] ?? '15000', 10),

  /** Session response timeout in milliseconds (env-overridable, default 10 min) */
  SESSION_RESPONSE_MS: parseInt(process.env['SQUAD_SESSION_TIMEOUT_MS'] ?? '600000', 10),
} as const;

// ============================================================================
// Agent Roles
// ============================================================================

export const AGENT_ROLES = ['lead', 'developer', 'tester', 'designer', 'scribe', 'coordinator'] as const;
export type AgentRole = typeof AGENT_ROLES[number];
