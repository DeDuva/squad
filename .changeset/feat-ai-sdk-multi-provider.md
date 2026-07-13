---
"@bradygaster/squad-sdk": minor
"@bradygaster/squad-cli": minor
---

Add Anthropic support via a Vercel AI SDK-backed provider layer (M3)

Replaces the hand-rolled Gemini REST/SSE client (`adapter/gemini-client.ts`) with a provider-agnostic `AiSdkSession`/`AiSdkClient` built on the Vercel AI SDK (`ai` + `@ai-sdk/google` + `@ai-sdk/anthropic`), and adds first-class Anthropic support alongside Gemini.

**What changed**

- New `adapter/backend.ts` (`SquadBackendClient` interface) — `SquadClient` now depends on this interface instead of hardwiring a concrete backend class.
- New `adapter/ai-sdk-session.ts` / `adapter/ai-sdk-client.ts` replace `GeminiSession`/`GeminiClient`. Provider is resolved per-session by model-ID prefix (`claude-*` → Anthropic, else Google). The AI SDK's built-in multi-step tool loop replaces the old hand-rolled recursive tool-call handler, while preserving its exact hook semantics (`onPreToolUse`/`onPostToolUse` ordering, deny short-circuiting, `modifiedArgs`/`modifiedResult`, `maxToolCallRounds` enforcement).
- Model catalog (`config/models.ts`) gains three Anthropic entries: `claude-opus-4-8` (premium), `claude-sonnet-5` (standard), `claude-haiku-4-5` (fast), with pricing, and cross-provider fallback/economy-mode chains.
- `squad auth setup/status/logout` now accepts `--provider=anthropic` in addition to `gemini`; `squad doctor` reports Anthropic key status (warn, not fail, when unconfigured — Gemini remains the required default provider).
- `SquadClientOptions.geminiApiKey` is now deprecated in favor of `apiKeys: { gemini, anthropic }`; the old field is kept as a back-compat alias.

**Removed**: `adapter/gemini-client.ts` and its dedicated test suite, superseded by `test/ai-sdk-session-{hooks,depth,mcp-warning,streaming}.test.ts`.

**Not yet done** (tracked as follow-up milestones): retry/backoff, parallel tool-call execution, session persistence, and context compaction are unchanged from before this PR — this milestone is scoped to the provider-layer swap and Anthropic enablement only.
