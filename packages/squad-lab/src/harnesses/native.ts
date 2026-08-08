/**
 * The squad-native arm, as a `SessionFactory` in its own right.
 *
 * `harnesses/ai-sdk.ts` has always been a standalone factory: hand it a bus and
 * a provider and it yields sessions, with no coordinator anywhere in sight. Its
 * opposite number had no such existence — the native arm lived inline inside
 * `run-variant.ts`'s `fanOutDeps.createSession`, and a second, slightly
 * different copy lived inside `scripts/harness-check.ts`. Two consequences
 * followed from that, and both mattered.
 *
 * The first is that the two arms were not really symmetric. The conformance
 * suite judges a `SessionFactory`; the neutral loop could be handed to it
 * directly while the native one had to be reconstructed by whoever wanted to
 * test it, which is precisely how the harness-check copy came to differ from
 * the run-variant one (it always replaces the system message and always filters
 * tools, regardless of the variant's settings).
 *
 * The second is that anything wanting to drive squad's own backends had to
 * build a `SquadCoordinator` to get at them, dragging in the routing layer —
 * including `shouldHandleDirectly()`, which can answer a goal itself and
 * produce a run with no agent in it at all.
 *
 * So this is the native arm with the coordinator taken off it: the same
 * `SquadClient.createSession` call with the same three parity settings, behind
 * the same interface the neutral loop already satisfies. Both arms are now
 * things you can hand to `checkHarnessConformance` unmodified, and both can be
 * driven without routing.
 *
 * `scripts/harness-check.ts` now certifies *this* factory, so the arm the gate
 * passes is the arm duva-bench runs. `run-variant.ts` deliberately still builds
 * its own: it is a live experimental path with merged results behind it, and
 * changing when its `SquadClient` connects would shift the neutral arm's
 * recorded telemetry for no benefit to anyone. Folding it in is safe only
 * alongside a re-baseline, which is not this milestone's job.
 *
 * The parity settings are not defaults for tidiness. Each one is a confound
 * that made a previous comparison meaningless, and the commentary on each says
 * which.
 */

import { SquadClient } from '@deduvafork/squad-sdk/client';
import type { EventBus } from '@deduvafork/squad-sdk/runtime/event-bus';
import { VENDORS, type SquadProvider } from '@deduvafork/squad-sdk/config/vendors';

import type { ConformingSession, SessionFactory } from '../conformance.js';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_TOOL_SURFACE, type SystemPromptMode, type ToolSurface } from '../harness.js';
import { MCP_BRIDGE_PREFIX } from '../tools/taxonomy.js';

/** The name the Agent SDK matches a bridged squad tool against. */
const mcpToolName = (name: string) => `${MCP_BRIDGE_PREFIX}${name}`;

export interface NativeHarnessOptions {
  bus: EventBus;
  provider: SquadProvider;
  /** Default model id. A per-session `config.model` still wins. */
  model?: string;
  /**
   * The vendor key, passed rather than inherited.
   *
   * Optional on purpose, and asymmetric for a reason worth stating: the
   * Anthropic backend wraps the `claude` CLI's agent SDK and inherits its
   * credential chain, so it can run with nothing passed. Gemini has no such
   * chain. Callers that want a key to be mandatory should check before calling.
   */
  apiKey?: string;
  /**
   * Scopes the backend's *own* Read/Write/Edit/Bash to one clone.
   *
   * Without it those operate on the process cwd, and an agent writes a correct
   * module into entirely the wrong tree.
   */
  workingDirectory?: string;
  toolSurface?: ToolSurface;
  systemPrompt?: SystemPromptMode;
  /** Sequential tool rounds per agent, when a session does not name its own. */
  defaultMaxToolRounds?: number;
}

export interface NativeHarness {
  createSession: SessionFactory;
  /** Disconnect the underlying client. Safe to call more than once. */
  close: () => Promise<void>;
}

/**
 * Connect a client and expose its sessions as a `SessionFactory`.
 *
 * Connecting here rather than lazily means a bad key or an unreachable backend
 * fails before a workspace is cloned or a run is opened, instead of at the
 * first agent turn — where it would already be inside a recorded run.
 */
export async function createNativeHarness(options: NativeHarnessOptions): Promise<NativeHarness> {
  const toolSurface = options.toolSurface ?? DEFAULT_TOOL_SURFACE;
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  // The provider is passed, never written. `resolveProvider` returns an
  // explicit provider on its first line, before it reads `.squad/config.json`
  // — so two variants never race on that file, because neither touches it.
  const client = new SquadClient({
    provider: options.provider,
    ...(options.provider === 'gemini' && options.apiKey ? { geminiApiKey: options.apiKey } : {}),
    ...(options.provider === 'anthropic' && options.apiKey ? { anthropicApiKey: options.apiKey } : {}),
    eventBus: options.bus,
  } as never);

  await (client as unknown as { connect: () => Promise<void> }).connect();

  const createSession: SessionFactory = async (config) => {
    // The coordinator named agents only through `clientName`; a direct caller
    // passes `agentName`. Accept either, because the recorder keys an ADP
    // session off the agent and an unnamed one silently merges two agents' work.
    const fromClientName = String(config.clientName ?? '').replace(/^squad-agent-/, '');
    const agentName = config.agentName ?? (fromClientName || 'agent');
    const tools = config.tools ?? [];
    const workingDirectory = config.workingDirectory ?? options.workingDirectory;

    return (await (client as unknown as {
      createSession: (c: unknown) => Promise<unknown>;
    }).createSession({
      model: config.model ?? options.model ?? VENDORS[options.provider].models.standard,
      clientName: config.clientName ?? `squad-agent-${agentName}`,
      agentName,
      ...(workingDirectory ? { workingDirectory } : {}),
      tools,
      // One budget, enforced in `adapter/client.ts` for every backend.
      maxToolRounds: config.maxToolRounds ?? options.defaultMaxToolRounds,
      // Naming the surface explicitly is what makes the two vendors comparable.
      // Left unset, the Anthropic backend adds its own Read/Write/Edit/Glob/
      // Grep/Bash and the Gemini backend does not, so the two runs are not the
      // same program — which is how the M7 slice reported a 100x token
      // difference that was a tooling difference wearing a model's name.
      ...(toolSurface === 'registered'
        ? {
            availableTools: tools.map((t) => mcpToolName(t.name)),
            // Both, and the second one is the one that works. `availableTools`
            // filters permission; `builtinTools: false` is what stops the
            // backend registering its own tools at all.
            builtinTools: false,
          }
        : {}),
      systemMessage:
        systemPrompt === 'charter-only'
          ? // `replace` drops the backend's own preset. Without it the Anthropic
            // agents get Claude Code's entire system message *plus* the charter
            // while the Gemini agents get the charter alone — a confound that
            // survives fixing the tools, and a quieter one, because nothing in
            // the telemetry shows it.
            { mode: 'replace' as const, content: config.systemMessage?.content ?? '' }
          : { content: config.systemMessage?.content ?? '' },
    })) as ConformingSession;
  };

  return {
    createSession,
    close: async () => {
      await (client as unknown as { disconnect?: () => Promise<void> }).disconnect?.();
    },
  };
}
