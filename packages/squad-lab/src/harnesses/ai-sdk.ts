/**
 * A neutral agent loop, built on the Vercel AI SDK.
 *
 * squad's own backends are two different programs wearing one interface: one
 * wraps a vendor agent SDK with its own tool surface and system preset, the
 * other is a hand-written streaming loop. Holding them equal took four rounds of
 * finding a harness defect that had been read as a model deficiency. This is the
 * alternative — **one loop, one prompt, one tool schema, one stop condition**,
 * with the provider as a parameter.
 *
 * It is deliberately not a rewrite of squad. It plugs into the same
 * `createSession` seam and emits the same bus events, so the recorder, the run
 * attestation, the grader, the summary and the SPA are all unchanged — and it
 * is measured by the same conformance contract and wire probe as the native
 * harness, which is what makes "how much of the gap is scaffold?" a question
 * with an answer rather than a worry.
 *
 * What the SDK provides that we would otherwise be writing again:
 *
 *  - `stopWhen: stepCountIs(n)` — the portable round budget we had to enforce by
 *    hand in `adapter/client.ts` because one backend capped rounds and the other
 *    did not.
 *  - per-step usage, so token accounting is not a per-provider reimplementation.
 *  - the provider quirks. Gemini returns a `thought_signature` with a function
 *    call that must be sent back on the next turn; a loop written from two API
 *    references drops it, degrades Gemini's multi-turn tool use, and the
 *    degradation looks exactly like a weaker model. That is the fifth instance
 *    of the pattern, avoided by not owning the wire format.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { VENDORS } from '@deduvafork/squad-sdk/config/vendors';
import { generateText, jsonSchema, stepCountIs, tool, type LanguageModel, type ModelMessage } from 'ai';
import { randomUUID } from 'node:crypto';

import type { EventBus } from '@deduvafork/squad-sdk/runtime/event-bus';
import type { ConformingSession, SessionFactory } from '../conformance.js';
import { priceUsage, toMicroUsd, type PriceTable } from '../pricing.js';

/**
 * The providers this loop can reach.
 *
 * Anthropic was meant to come first, so the migration could be controlled — same
 * model, two harnesses, any difference attributable to the harness. It is
 * reachable in code and unvalidated live: the SDK provider wants an API key and
 * this machine authenticates through the `claude` CLI's OAuth chain instead.
 * Gemini goes first in practice for the mundane reason that its key is a key.
 */
export type AiSdkProvider = 'anthropic' | 'gemini';

export interface AiSdkHarnessOptions {
  bus: EventBus;
  provider: AiSdkProvider;
  /** Falls back to whatever the caller passed per-session. */
  model?: string;
  /** Rounds allowed when a session does not name its own. */
  defaultMaxToolRounds?: number;
  /** Passed explicitly rather than read from the environment. See `defaultResolver`. */
  apiKey?: string;
  /**
   * Rates used to price usage the SDK reports without a cost.
   *
   * The AI SDK gives tokens and leaves pricing to the caller, so without this
   * every run on this harness recorded `cost_micro_usd: 0` — unknown wearing
   * the shape of free. Absent from the table means the run is `unpriced`.
   */
  priceTable?: PriceTable;
  /**
   * How a model id becomes a model.
   *
   * Injectable for two reasons that are really one: a test can supply a mock
   * and prove the loop conforms without a key or a bill, and adding a provider
   * is this line rather than a branch through the loop. Defaults to Anthropic.
   */
  resolveModel?: (modelId: string) => LanguageModel;
}

interface LabToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * The result a squad tool returns, flattened to what a model should see.
 *
 * squad's own tools answer `{ textResultForLlm, resultType }`; the conformance
 * tools answer a bare value. Both have to work, because the point of this
 * harness is that it runs the same tools the native one does.
 */
function readToolResult(raw: unknown): { text: string; failed: boolean } {
  if (raw && typeof raw === 'object' && 'textResultForLlm' in raw) {
    const r = raw as { textResultForLlm?: unknown; resultType?: unknown };
    return {
      text: String(r.textResultForLlm ?? ''),
      failed: typeof r.resultType === 'string' && r.resultType !== 'success',
    };
  }
  return { text: typeof raw === 'string' ? raw : JSON.stringify(raw ?? null), failed: false };
}

/**
 * One line per provider, which is the point of the abstraction.
 *
 * Both keys are passed explicitly rather than left to the environment: the
 * lab's rule everywhere else is that `GEMINI_API_KEY` merely being set does not
 * select that vendor, and a harness that picked a provider up from ambient
 * state would be a second way for a run to differ without saying so. Anthropic
 * used to be the exception — a bare `anthropic(id)` reading whatever
 * `ANTHROPIC_API_KEY` happened to hold — which made the one arm this file was
 * written to enable the one arm that broke its own rule.
 */
function defaultResolver(options: AiSdkHarnessOptions): (id: string) => LanguageModel {
  if (options.provider === 'gemini') {
    const google = createGoogleGenerativeAI(options.apiKey ? { apiKey: options.apiKey } : {});
    return (id: string) => google(id);
  }
  const anthropic = createAnthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  return (id: string) => anthropic(id);
}

export function createAiSdkHarness(options: AiSdkHarnessOptions): SessionFactory {
  const { bus } = options;

  return async (config): Promise<ConformingSession> => {
    const sessionId = randomUUID();
    const agentName = config.agentName ?? 'agent';
    const budget = config.maxToolRounds ?? options.defaultMaxToolRounds ?? 120;
    // The registry, not a literal. The last hardcoded default outlived the
    // model it named and pointed at an id the vendor list no longer carried.
    const modelId = config.model ?? options.model ?? VENDORS[options.provider].models.standard;
    const labTools = (config.tools ?? []) as unknown as LabToolLike[];
    const resolveModel = options.resolveModel ?? defaultResolver(options);

    const emit = (type: string, payload: Record<string, unknown>): void => {
      void bus.emit({ type, sessionId, agentName, payload, timestamp: new Date() } as never);
    };

    // Conversation state lives here, not in the SDK: a session may take more
    // than one turn, and each has to see what the last one did.
    const messages: ModelMessage[] = [];
    let controller = new AbortController();
    let abortRequested = false;

    const tools = Object.fromEntries(
      labTools.map((t) => [
        t.name,
        tool({
          description: t.description,
          // The lab's tools carry JSON Schema, which is what both backends were
          // already handed — converting to Zod here would be a second schema
          // dialect and a second place for a constraint to get lost.
          inputSchema: jsonSchema(t.parameters as never),
          execute: async (args: unknown) => {
            const startedAt = Date.now();
            let result: { text: string; failed: boolean };
            try {
              result = readToolResult(await t.handler((args ?? {}) as Record<string, unknown>));
            } catch (err) {
              // A throwing tool is a reported failed call, never a dead turn:
              // tool failure rate is a headline comparison number, and a
              // harness that lets one kill the run reports a different thing
              // from one that does not.
              result = { text: `error: ${(err as Error).message}`, failed: true };
            }
            emit('session:tool_call', {
              toolName: t.name,
              toolArgs: (args ?? {}) as Record<string, unknown>,
              resultType: result.failed ? 'failure' : 'success',
              durationMs: Date.now() - startedAt,
            });
            return result.text;
          },
        }),
      ]),
    );

    // No `session:created` here, and no `session:message` either. Both were
    // tried and both were wrong: fan-out emits the lifecycle pair around
    // whatever session factory it was handed, so emitting one here would
    // double-count it, and *neither* arm emits `session:message` — the
    // recorder's `kind: 'message'` case is reachable only from a producer that
    // does not exist yet. Adding it to this arm alone would have created the
    // asymmetry this file exists to remove, in the other direction.
    const runTurn = async (prompt: string): Promise<string> => {
      abortRequested = false;
      controller = new AbortController();
      messages.push({ role: 'user', content: prompt });

      let steps = 0;
      // Wall-clock per step, kept here because the SDK reports usage without
      // timing and ADP has a `duration_ms` column per event. Left unset, every
      // model call on this arm recorded 0 against the native arm's real
      // seconds — a run that looks instant rather than one that was.
      let stepStartedAt = Date.now();
      try {
        const result = await generateText({
          model: resolveModel(modelId),
          // Passed as `system` rather than pushed into `messages`: the SDK
          // warns that a system role in the message list is a prompt-injection
          // surface, and `replace` semantics are all this harness offers
          // anyway — identical instructions for every provider is the point.
          ...(config.systemMessage?.content ? { system: config.systemMessage.content } : {}),
          messages,
          ...(Object.keys(tools).length > 0 ? { tools } : {}),
          // The budget, as a first-class setting rather than something counted
          // by hand in a shared bridge.
          stopWhen: stepCountIs(budget),
          abortSignal: controller.signal,
          onStepFinish: (step) => {
            steps += 1;
            const durationMs = Date.now() - stepStartedAt;
            stepStartedAt = Date.now();
            // AI SDK v7 moved the cache breakdown into `inputTokenDetails` and made
            // `inputTokens` the *total* prompt count, cached reads included. TokenUsage
            // documents inputTokens and cachedInputTokens as disjoint, and priceUsage
            // adds them, so taking `inputTokens` here would bill every cache read twice.
            // `noCacheTokens` is the disjoint figure v5's `inputTokens` used to carry.
            const usage = step.usage;
            const cachedInputTokens = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
            const inputTokens =
              usage?.inputTokenDetails?.noCacheTokens ??
              Math.max((usage?.inputTokens ?? 0) - cachedInputTokens, 0);
            const outputTokens = usage?.outputTokens ?? 0;
            // Cache reads are billed at a fraction of the input rate and are
            // most of a long agent turn, so pricing them as ordinary input
            // would overstate the run several times over.
            const priced = priceUsage(
              modelId,
              { inputTokens, outputTokens, cachedInputTokens },
              { ...(options.priceTable ? { table: options.priceTable } : {}) },
            );
            emit('session:model_usage', {
              model: modelId,
              inputTokens,
              outputTokens,
              ...(cachedInputTokens ? { cacheReadInputTokens: cachedInputTokens } : {}),
              // Absent rather than zero when unpriced: CostTracker and ADP both
              // read a missing field as "no figure", and a `0` as "free".
              ...(priced.costUsd === null ? {} : { estimatedCost: priced.costUsd }),
              costBasis: priced.basis,
              ...(priced.tableDigest ? { priceTable: priced.tableId, priceTableDigest: priced.tableDigest } : {}),
              durationMs,
              agentName,
            });
          },
        });

        messages.push(...result.response.messages);

        // Stopping at the ceiling is an outcome. Reported as a milestone so a
        // variant that spent its budget is distinguishable from one that
        // crashed — they are the same empty row in a summary otherwise.
        if (steps >= budget) {
          emit('agent:milestone', { event: 'budget.exhausted', agentName, rounds: steps, budget });
        }
        return result.text;
      } catch (err) {
        if (abortRequested || controller.signal.aborted) {
          // We stopped it, so this is an outcome and not an error — but it is
          // not the *same* outcome as running out of rounds, and this used to
          // report both as `budget.exhausted`. A variant stopped by its
          // deadline would then be recorded as having spent a budget it never
          // reached, which is a wrong answer to "why did this one stop?".
          emit('agent:milestone', { event: 'turn.aborted', agentName, rounds: steps, budget });
          return '';
        }
        emit('session:error', { agentName, error: (err as Error).message });
        throw err;
      }
    };

    return {
      sessionId,
      sendMessage: async (opts) => {
        await runTurn(opts.prompt);
      },
      sendAndWait: async (opts, timeoutMs) => {
        if (timeoutMs === undefined) return runTurn(opts.prompt);
        // The SDK has no turn timeout of its own, and a bound that only one
        // harness enforces is the asymmetry this whole exercise is about.
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            runTurn(opts.prompt),
            new Promise<string>((resolvePromise) => {
              timer = setTimeout(() => {
                abortRequested = true;
                controller.abort();
                resolvePromise('');
              }, timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
      abort: async () => {
        abortRequested = true;
        controller.abort();
      },
    };
  };
}
