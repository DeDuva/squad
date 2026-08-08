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

/** Which loop drives the model. Orthogonal to topology. */
export type ArmHarness = 'squad-native' | 'ai-sdk';

/**
 * How many agents that loop drives, and whether anything routes between them.
 *
 * Separate from `harness` on purpose: conflating them would make "swarm" a
 * third loop and prevent the contrast that matters — the *same* loop, run as
 * one agent and as a routed squad, which is the only form in which the topology
 * effect is isolated from the harness effect.
 */
export type ArmTopology = 'single' | 'swarm';

export interface ArmSpec {
  /** Stable identifier, used in `external_ref` and as a run label. */
  id: string;
  harness: ArmHarness;
  topology?: ArmTopology;
  provider: SquadProvider;
  /** Explicit model id. Falls back to the vendor's model for `tier`. */
  model?: string;
  tier?: 'premium' | 'standard' | 'fast';
  toolSurface?: ToolSurface;
  systemPrompt?: SystemPromptMode;
  maxToolRounds?: number;
  /** Swarm topology only. Folded into `harnessDigest`, so it moves the digest. */
  agents?: Array<{ name: string; role: string; prompt: string }>;
  routing?: Array<{ workType: string; agents: string[]; confidence: 'high' | 'medium' | 'low'; examples: string[] }>;
}

/** An arm that has been connected and can produce sessions. */
export interface OpenArm {
  createSession: SessionFactory;
  /** The model actually resolved, which is what gets recorded. */
  model: string;
  close: () => Promise<void>;
}

/**
 * True when an arm's session emits its own `session:created`/`session:destroyed`.
 *
 * Lives here rather than beside the swarm so the runner can ask the question
 * without importing the module that pulls in `SquadCoordinator`. Fan-out emits
 * the lifecycle pair per agent; a runner that emitted its own on top would open
 * a phantom ADP session for an agent that never ran.
 */
export function emitsOwnLifecycle(session: object): boolean {
  return (session as { emitsLifecycle?: boolean }).emitsLifecycle === true;
}

export interface OpenArmContext {
  bus: import('@deduvafork/squad-sdk/runtime/event-bus').EventBus;
  /** The variant's clone. Scopes any backend-native file tools to it. */
  workingDirectory: string;
  /** The vendor key, passed rather than inherited from the environment. */
  apiKey?: string;
}
