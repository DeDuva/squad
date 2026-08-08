/**
 * What an arm is, independent of which loop implements it.
 *
 * An arm is one cell's execution layer: the loop, the vendor, the model, and
 * the three parity settings that decide whether two cells are the same program.
 * Everything here is a value rather than a live object, because an arm has to
 * survive being written into a study spec, digested, and re-read in a child
 * process — `openArm` is what turns it into something that can run.
 */

import type { SquadProvider } from '@deduvafork/squad-sdk/config/vendors';
import type { SessionFactory } from '@deduvafork/squad-lab/conformance';
import type { SystemPromptMode, ToolSurface } from '@deduvafork/squad-lab/harness';

/**
 * Which loop drives the model.
 *
 * `swarm` is spec'd here and wired in S4; `openArm` rejects it until then
 * rather than silently running a single agent under a topology label, which
 * would put a wrong `topology` on an attested run.
 */
export type ArmHarness = 'squad-native' | 'ai-sdk' | 'swarm';

export interface ArmSpec {
  /** Stable identifier, used in `external_ref` and as a run label. */
  id: string;
  harness: ArmHarness;
  provider: SquadProvider;
  /** Explicit model id. Falls back to the vendor's model for `tier`. */
  model?: string;
  tier?: 'premium' | 'standard' | 'fast';
  toolSurface?: ToolSurface;
  systemPrompt?: SystemPromptMode;
  maxToolRounds?: number;
}

/** An arm that has been connected and can produce sessions. */
export interface OpenArm {
  createSession: SessionFactory;
  /** The model actually resolved, which is what gets recorded. */
  model: string;
  close: () => Promise<void>;
}

export interface OpenArmContext {
  bus: import('@deduvafork/squad-sdk/runtime/event-bus').EventBus;
  /** The variant's clone. Scopes any backend-native file tools to it. */
  workingDirectory: string;
  /** The vendor key, passed rather than inherited from the environment. */
  apiKey?: string;
}
