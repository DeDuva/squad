# Squad (DeDuva/squad fork of bradygaster/squad)

## What this repo is
A fork of [bradygaster/squad](https://github.com/bradygaster/squad) — a multi-agent AI development team runtime. The fork adds pluggable LLM provider support (Anthropic Claude, Google Gemini, GitHub Copilot) and switches to source-only distribution.

The user-facing interface is unchanged: agent names, charters, `.squad/` files, GitHub issue labels, CLI commands, `.github/agents/squad.agent.md` all work identically regardless of provider.

---

## Current state
**Branch:** `feat/multi-provider` — pushed to `https://github.com/DeDuva/squad`
**PR:** https://github.com/DeDuva/squad/pull/1

**Original implementation plan:** @.claude/plan-multi-provider.md

**What's done:**
- Multi-provider architecture: `ISquadClientBackend` + `CopilotBackend` / `AnthropicBackend` / `GeminiBackend`
- Package rename: `@bradygaster/squad-sdk` → `@squad/sdk`, `@bradygaster/squad-cli` → `@squad/cli`
- Provider selected during `squad init`, written to `.squad/provider.json` (gitignored)
- Self-update checks GitHub commits API (DeDuva/squad) instead of npm registry
- README rewritten with attribution, provider table, source setup instructions
- Build verified: `npm run build` passes, `squad --version` works

**Next step:** Open a PR from `feat/multi-provider` → `main` on DeDuva/squad.

---

## Monorepo layout
```
packages/
  squad-sdk/   → @squad/sdk   — core runtime, adapter, providers, state
  squad-cli/   → @squad/cli   — CLI commands, shell, init, spawn
```

### Key files for the multi-provider feature
| File | Purpose |
|------|---------|
| `packages/squad-sdk/src/adapter/providers/base.ts` | `ISquadClientBackend` interface, `SquadProviderType`, `UnsupportedOperationError` |
| `packages/squad-sdk/src/adapter/providers/copilot.ts` | `CopilotBackend` — extracted Copilot implementation |
| `packages/squad-sdk/src/adapter/providers/anthropic.ts` | `AnthropicBackend` + `AnthropicSession` |
| `packages/squad-sdk/src/adapter/providers/gemini.ts` | `GeminiBackend` + `GeminiSession` |
| `packages/squad-sdk/src/adapter/providers/factory.ts` | `createBackend()` factory |
| `packages/squad-sdk/src/adapter/client.ts` | `SquadClient` — thin OTel wrapper, delegates to backend |
| `packages/squad-sdk/src/client/index.ts` | `@squad/sdk/client` entrypoint — re-exports `SquadProviderType` |
| `packages/squad-sdk/src/config/schema.ts` | `ProviderConfig` interface, `provider?` field on `SquadConfig` |
| `packages/squad-cli/src/cli/core/init.ts` | Interactive provider picker → `.squad/provider.json` |
| `packages/squad-cli/src/cli/shell/spawn.ts` | Reads provider config, constructs `SquadClient` |
| `packages/squad-cli/src/cli/self-update.ts` | GitHub commits API update check |

---

## Build & run
```bash
npm install          # workspace install (both packages)
npm run build        # tsc both packages → dist/
npm run lint         # tsc --noEmit (type check only)
npm test             # vitest run

# Make CLI available in shell
alias squad="node $(pwd)/packages/squad-cli/dist/cli-entry.js"
squad --version
```

## Provider config (runtime)
`.squad/provider.json` (gitignored) — written by `squad init`:
```json
{ "type": "anthropic", "anthropic": { "defaultModel": "claude-sonnet-4-5" } }
{ "type": "gemini",    "gemini":    { "defaultModel": "gemini-2.5-flash" } }
{ "type": "copilot" }
```
API keys: `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` env vars (or inline in the JSON).

---

## Architecture notes
- **Lazy imports**: `@anthropic-ai/sdk` and `@google/genai` are `optionalDependencies` loaded with `await import()` only when the relevant provider is active — won't crash if not installed.
- **In-memory history**: Anthropic and Gemini sessions maintain `MessageParam[]` / `Content[]` arrays for multi-turn conversations (no native session persistence unlike Copilot).
- **OTel stays in `SquadClient`**: All span wrapping is in the outer class, not in the backends.
- **Backward compat**: `provider` defaults to `'copilot'` everywhere — existing setups work unchanged.

---

## Repo URLs
- Fork: https://github.com/DeDuva/squad
- Upstream: https://github.com/bradygaster/squad
