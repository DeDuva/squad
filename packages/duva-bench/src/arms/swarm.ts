/**
 * The topology arm: a real squad, not a single agent.
 *
 * This is the one file in `packages/duva-bench` permitted to import
 * `SquadCoordinator`, and the boundary test enforces that by path. Everything
 * else in this package reaches models through a `SessionFactory` precisely so
 * the routing layer cannot leak into the trial path — but the whole point of a
 * topology arm is to *measure* the routing layer, so here it is, in one file,
 * where a reader can audit exactly what it does.
 *
 * **The hazard is handled, not inherited.** S1 removed the coordinator because
 * `handleMessage` runs `shouldHandleDirectly()` before routing and answers
 * matching goals itself — no agent, no tools, an empty trajectory that closes
 * looking like any other run. Bringing the coordinator back brings that back
 * too, and `run-variant.ts`'s mistake was never checking. So this arm inspects
 * `result.strategy` and refuses a direct response outright. A trial that would
 * have been silently empty becomes a loud failure instead, which is the only
 * safe way to have a coordinator inside a benchmark.
 *
 * The swarm presents itself as a `ConformingSession` so the runner needs no
 * branch: `sendAndWait` is `handleMessage`, which resolves at quiescence once
 * every agent's turn has completed. It declares `emitsLifecycle`, because
 * fan-out already emits `session:created`/`session:destroyed` per agent — the
 * runner emitting its own pair on top would open a phantom ADP session for an
 * agent that never existed.
 */

import { SquadCoordinator } from '@deduvafork/squad-sdk/coordinator';
import { SessionPool } from '@deduvafork/squad-sdk/client';
import type { EventBus } from '@deduvafork/squad-sdk/runtime/event-bus';
import type { SquadProvider } from '@deduvafork/squad-sdk/config/vendors';
import type { ConformingSession, SessionFactory } from '@deduvafork/squad-lab/conformance';

/** One agent in the swarm. Its prompt is its charter. */
export interface SwarmAgent {
  name: string;
  role: string;
  prompt: string;
}

/** How work is routed to those agents. Folded into `harnessDigest`. */
export interface SwarmRoutingRule {
  workType: string;
  agents: string[];
  confidence: 'high' | 'medium' | 'low';
  examples: string[];
}

export class DirectResponseError extends Error {
  constructor(readonly category: string | undefined) {
    super(
      `the coordinator answered the goal itself (strategy=direct, category=${category ?? 'unknown'}) ` +
        'and spawned no agent — this trial has no trajectory and must not be scored',
    );
    this.name = 'DirectResponseError';
  }
}

export interface SwarmOptions {
  bus: EventBus;
  provider: SquadProvider;
  model: string;
  agents: SwarmAgent[];
  routing: SwarmRoutingRule[];
  /**
   * How each agent's session is made.
   *
   * Injected rather than built here: the swarm is a *topology*, and it has to
   * be composable with either harness or the arm would confound topology with
   * loop. The coordinator drives whatever factory it is handed.
   */
  createAgentSession: SessionFactory;
  workingDirectory: string;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown>; handler: (args: never, ctx?: never) => Promise<unknown> }>;
  maxToolRounds?: number;
  turnTimeoutMs?: number;
}

export interface SwarmSession extends ConformingSession {
  /** Fan-out emits the lifecycle pair per agent; the runner must not duplicate it. */
  readonly emitsLifecycle: true;
}

/**
 * Build the swarm as a single session the runner can drive.
 *
 * The coordinator is configured with routing only. Models are resolved by the
 * injected factory rather than from `.squad/config.json`, so two concurrent
 * trials never race on a shared config file — the same reason `run-variant.ts`
 * passes its provider instead of writing it.
 */
export function createSwarmSession(options: SwarmOptions): SwarmSession {
  const charters = new Map(options.agents.map((a) => [a.name, a]));
  const pool = new SessionPool();

  const coordinator = new SquadCoordinator({
    config: {
      version: '1',
      models: {},
      routing: { rules: options.routing },
    },
    eventBus: options.bus,
    ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    fanOutDeps: {
      compileCharter: async (agentName: string) => {
        const agent = charters.get(agentName);
        return {
          name: agentName,
          displayName: agentName,
          role: agent?.role ?? 'Agent',
          expertise: [],
          style: 'concise',
          prompt: agent?.prompt ?? 'You are a helpful agent.',
        };
      },
      resolveModel: async () => options.model,
      createAgentSession: undefined,
      createSession: async (config: { clientName?: string; model?: string }) => {
        const agentName = String(config.clientName ?? '').replace(/^squad-agent-/, '') || 'agent';
        return options.createAgentSession({
          model: config.model ?? options.model,
          clientName: config.clientName ?? `squad-agent-${agentName}`,
          agentName,
          workingDirectory: options.workingDirectory,
          tools: options.tools as never,
          systemMessage: { mode: 'replace', content: charters.get(agentName)?.prompt ?? '' },
          ...(options.maxToolRounds !== undefined ? { maxToolRounds: options.maxToolRounds } : {}),
        }) as never;
      },
      sessionPool: pool,
      eventBus: options.bus,
    },
  } as never) as unknown as {
    handleMessage: (message: string, context: unknown) => Promise<{ strategy?: string; directResponse?: { category?: string } }>;
  };

  return {
    sessionId: 'swarm',
    emitsLifecycle: true,
    sendMessage: async (opts) => {
      await runTurn(coordinator, options.bus, opts.prompt);
    },
    sendAndWait: async (opts) => runTurn(coordinator, options.bus, opts.prompt),
    abort: async () => {
      // The coordinator has no abort of its own; the runner's deadline is the
      // outer guarantee and the pool is dropped with the trial's process.
    },
  };
}

async function runTurn(
  coordinator: { handleMessage: (message: string, context: unknown) => Promise<{ strategy?: string; directResponse?: { category?: string } }> },
  bus: EventBus,
  prompt: string,
): Promise<string> {
  const result = await coordinator.handleMessage(prompt, {
    sessionId: 'coordinator',
    config: {},
    eventBus: bus,
  });

  // The check `run-variant.ts` never made. A goal whose wording happens to match
  // a built-in pattern must fail the trial, not quietly produce an empty one.
  if (result.strategy === 'direct') {
    throw new DirectResponseError(result.directResponse?.category);
  }

  return result.strategy ?? 'routed';
}

/** True when an arm's session emits its own lifecycle events. */
export function emitsOwnLifecycle(session: ConformingSession): boolean {
  return (session as { emitsLifecycle?: boolean }).emitsLifecycle === true;
}

/**
 * The default swarm: three agents and a routing table.
 *
 * Deliberately small and explicit. The auto-generated variant id cannot express
 * a topology, so a swarm arm names its agents in the spec and they land in
 * `harnessDigest` — which folds `agents` and `routing` — giving a swarm arm a
 * different harness digest from the single-agent arm it is contrasted with.
 */
export const DEFAULT_SWARM_AGENTS: SwarmAgent[] = [
  {
    name: 'planner',
    role: 'Planner',
    prompt:
      'You plan the change. Inspect the repository with the tools provided, decide what to write, ' +
      'and state the plan concisely. Do not write files. When done, make no further tool calls.',
  },
  {
    name: 'implementer',
    role: 'Implementer',
    prompt:
      'You write the code. Use the tools provided to read what exists and write real files. ' +
      'When the task is complete, stop and make no further tool calls.',
  },
  {
    name: 'reviewer',
    role: 'Reviewer',
    prompt:
      'You check the work. Read what was written and run the tests with the tools provided. ' +
      'Fix only what is broken. When done, stop and make no further tool calls.',
  },
];

export const DEFAULT_SWARM_ROUTING: SwarmRoutingRule[] = [
  {
    workType: 'implementation',
    agents: ['planner', 'implementer', 'reviewer'],
    confidence: 'high',
    examples: ['add a module', 'implement a function', 'write tests'],
  },
];
