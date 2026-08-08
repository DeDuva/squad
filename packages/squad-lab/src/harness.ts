/**
 * What "the same harness" means, made checkable.
 *
 * The M7 slice compared three models and could not have told you anything about
 * them, because the harness was not held constant: the Anthropic backend ships
 * its own `Read`/`Write`/`Edit`/`Bash` alongside squad's registered tools and
 * the Gemini backend does not, so one vendor's agents worked with six more
 * tools than the other's. Anthropic spent 630,107 input tokens against Gemini's
 * 5,799 for the same delivered outcome. That is not a model difference; it is
 * two different programs.
 *
 * Two things live here. `toolSurface` and `systemPrompt` make the two known
 * confounds into **settings** rather than accidents — and `harnessDigest` makes
 * the resulting configuration a value that travels with the run, so "these runs
 * are comparable" is something a reader can check rather than something the
 * write-up asserts.
 *
 * The digest is deliberately the same shape of idea as `spec_digest`: that one
 * says two scores came from one rubric, this one says two runs came from one
 * harness. A comparison needs both to be true and neither is visible by eye.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from './grader.js';
import type { AgentSpec, RoutingRule, VariantLimits } from './run-variant.js';

/**
 * Which tools an agent may reach for.
 *
 * `registered` — only the tools the lab supplied. Both vendors then see exactly
 * the same surface, which is the only configuration in which a cross-vendor
 * score means anything. This is the default because comparison is what the lab
 * is for.
 *
 * `native` — the lab's tools plus whatever the backend brings. Better absolute
 * results on the Anthropic side, and not comparable with anything. Kept because
 * "how much did the tooling contribute?" is itself an experiment worth running
 * — it is just not the same experiment.
 */
export type ToolSurface = 'registered' | 'native';

/**
 * Whose instructions the agent gets.
 *
 * `charter-only` replaces the backend's own system message with the charter, so
 * both vendors receive identical text. Without it the Anthropic agents get
 * Claude Code's entire system preset *plus* the charter while the Gemini agents
 * get the charter alone — a confound that survives fixing the tools, and a
 * quieter one because nothing in the telemetry shows it.
 */
export type SystemPromptMode = 'charter-only' | 'backend-preset';

/**
 * Which agent loop drives the model.
 *
 * `squad-native` wraps a vendor agent SDK on one side and a hand-written
 * streaming loop on the other — one interface over two different programs.
 * `ai-sdk` is one loop for every provider. In the digest because they are not
 * the same harness, and running two arms is the point.
 */
export type HarnessImpl = 'squad-native' | 'ai-sdk';

export interface HarnessSpec {
  toolSurface: ToolSurface;
  systemPrompt: SystemPromptMode;
  agents: AgentSpec[];
  routing: RoutingRule[];
  /** Registered tool names, sorted — the surface, not the implementations. */
  tools: string[];
  limits: VariantLimits;
  /**
   * Sequential tool rounds an agent may spend.
   *
   * In the digest because two runs with different budgets are not the same
   * experiment — the first version of this file omitted it, and a vendor whose
   * backend capped rounds at ten still produced a digest identical to one that
   * ran unbounded.
   */
  maxToolRounds: number;
  harnessImpl: HarnessImpl;
  /** Pinned so an SDK upgrade shows up as a different harness, which it is. */
  sdkVersion: string;
  /**
   * Digest of the tool documentation the charter carries, when there is any.
   *
   * Tool *names* already move the digest, so a semantic twin is visible without
   * this. What is not otherwise visible is how much the agent was told about
   * those tools: two arms with identical twin names and different doc grades
   * are the central contrast of Study A, and without this field they would
   * share a harness digest and read as one cell.
   *
   * Optional, and absent means absent: `canonicalJson` drops `undefined`, so
   * every digest computed before this field existed is unchanged by it.
   */
  toolDocsDigest?: string;
}

export const DEFAULT_TOOL_SURFACE: ToolSurface = 'registered';
/**
 * Generous enough that real work is not what stops an agent.
 *
 * The old effective ceiling was ten, on one vendor only, and a real task needed
 * more: the run that exposed it made 105 tool calls on the unbounded backend
 * and was stopped at ten on the capped one.
 */
export const DEFAULT_MAX_TOOL_ROUNDS = 120;
/** The shipped loop. The neutral one is opt-in until it has a track record. */
export const DEFAULT_HARNESS_IMPL: HarnessImpl = 'squad-native';
export const DEFAULT_SYSTEM_PROMPT: SystemPromptMode = 'charter-only';

/**
 * A digest over everything that decides how an agent works, and nothing that
 * decides who it is.
 *
 * The model is excluded on purpose: varying the model while the harness digest
 * holds constant is exactly the experiment. Including it would make every cell
 * its own harness and the digest would say nothing.
 */
export function harnessDigest(spec: HarnessSpec): string {
  const canonical = {
    toolSurface: spec.toolSurface,
    systemPrompt: spec.systemPrompt,
    // Charter text is part of the harness: two runs given different
    // instructions were not driven the same way, however identical the code.
    agents: [...spec.agents]
      .map((a) => ({ name: a.name, role: a.role, prompt: a.prompt }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    routing: [...spec.routing]
      .map((r) => ({ workType: r.workType, agents: [...r.agents].sort(), confidence: r.confidence }))
      .sort((a, b) => a.workType.localeCompare(b.workType)),
    tools: [...spec.tools].sort(),
    limits: spec.limits,
    maxToolRounds: spec.maxToolRounds,
    harnessImpl: spec.harnessImpl,
    sdkVersion: spec.sdkVersion,
    toolDocsDigest: spec.toolDocsDigest,
  };
  return createHash('sha256').update(canonicalJson(canonical), 'utf8').digest('hex');
}

/** The labels a run carries so its harness is visible without re-deriving it. */
export function harnessLabels(spec: HarnessSpec): Record<string, string> {
  return {
    harness: harnessDigest(spec),
    tool_surface: spec.toolSurface,
    system_prompt: spec.systemPrompt,
    max_tool_rounds: String(spec.maxToolRounds),
    harness_impl: spec.harnessImpl,
  };
}
