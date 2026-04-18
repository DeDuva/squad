# Plan: Multi-Provider LLM Support + Source-Only Build + README

## Context
This is a fork of `bradygaster/squad`. The repo is hardwired to GitHub Copilot via `@github/copilot-sdk` as the only LLM backend. We need to: (1) add pluggable provider support for Copilot, Anthropic, and Gemini; (2) remove all references to bradygaster's published npm binaries so the project always runs from source; (3) update the README accordingly.

The interface (agent names, charters, `.squad/` files, GitHub issue labels, CLI shell commands) does not change — only the implementation of the LLM layer.

---

## Part 1: Feature Branch

```
git checkout -b feat/multi-provider
```

---

## Part 2: Package Renaming (bradygaster → @squad)

Remove the `@bradygaster/` npm scope from internal package names. Since we run from source the names are just workspace labels, but this fully removes the dependency on bradygaster's npm account.

### Files to change
| File | Change |
|---|---|
| `packages/squad-sdk/package.json` | `name: "@bradygaster/squad-sdk"` → `"@squad/sdk"` |
| `packages/squad-cli/package.json` | `name: "@bradygaster/squad-cli"` → `"@squad/cli"`, dep `"@bradygaster/squad-sdk"` → `"@squad/sdk"` |
| `package.json` (root) | Update `workspaces`, homepage, repository fields |
| All `*.ts` files importing `@bradygaster/squad-sdk/*` | Replace with `@squad/sdk/*` (grep-and-replace, ~15 CLI source files) |

### Key import patterns to replace
```
@bradygaster/squad-sdk  →  @squad/sdk
@bradygaster/squad-cli  →  @squad/cli
```

---

## Part 3: Provider Abstraction

The entire Copilot-specific code lives in one file: `packages/squad-sdk/src/adapter/client.ts`. The `SquadSession` interface in `adapter/types.ts` is already provider-agnostic — it's the contract both existing and new providers must implement.

### New directory: `packages/squad-sdk/src/adapter/providers/`

#### `base.ts` — `ISquadClientBackend` interface
Extracts the public API surface of the current `SquadClient` (minus OTel wrappers which stay in the outer class):
```typescript
export interface ISquadClientBackend {
  connect(): Promise<void>;
  disconnect(): Promise<Error[]>;
  forceDisconnect(): Promise<void>;
  createSession(config: SquadSessionConfig): Promise<SquadSession>;
  resumeSession(id: string, config: SquadSessionConfig): Promise<SquadSession>;
  listSessions(): Promise<SquadSessionMetadata[]>;
  deleteSession(id: string): Promise<void>;
  getLastSessionId(): Promise<string | undefined>;
  ping(msg?: string): Promise<{ message: string; timestamp: number }>;
  getStatus(): Promise<SquadGetStatusResponse>;
  getAuthStatus(): Promise<SquadGetAuthStatusResponse>;
  listModels(): Promise<SquadModelInfo[]>;
  on(eventTypeOrHandler: any, handler?: any): () => void;
  isConnected(): boolean;
}
```

#### `copilot.ts` — `CopilotBackend implements ISquadClientBackend`
Move the current `SquadClient` internals here verbatim (constructor takes current `SquadClientOptions`). No logic changes — pure extraction.

#### `anthropic.ts` — `AnthropicBackend` + `AnthropicSession`

`AnthropicSession implements SquadSession`:
- Holds a conversation history array (`{ role, content }[]`)
- `sendMessage({prompt})` → calls `anthropic.messages.stream()` with full history
  - On `content_block_delta` (text_delta): emits `message_delta` with `{ delta: text }`
  - On `message_delta` (final): emits `usage` with `{ inputTokens, outputTokens }`
  - On stream end: emits `idle`
- `sendAndWait` → same but accumulates and returns full text
- `abort` → calls `stream.controller.abort()`
- `close` → clears history, no-op otherwise

`AnthropicBackend`:
- `connect()` / `disconnect()` → no-op (stateless API)
- `isConnected()` → always `true`
- `createSession(config)` → `new AnthropicSession(anthropicClient, config.model ?? 'claude-sonnet-4-5', config.systemMessage)`
- `getAuthStatus()` → attempts a cheap API call to verify key validity
- `listModels()` → returns static list: `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`
- `resumeSession` / `listSessions` / `deleteSession` → throw `UnsupportedOperationError` with friendly message

#### `gemini.ts` — `GeminiBackend` + `GeminiSession`

`GeminiSession implements SquadSession`:
- Holds conversation history as Gemini `contents` array
- `sendMessage({prompt})` → calls `ai.models.generateContentStream()` with full history
  - On each chunk: emits `message_delta` with `{ delta: chunk.text }`
  - On final chunk with `usageMetadata`: emits `usage` with `{ inputTokens: promptTokenCount, outputTokens: candidatesTokenCount }`
  - After iteration: emits `idle`
- Similar pattern to Anthropic for `sendAndWait`, `abort`, `close`

`GeminiBackend`:
- Same no-op lifecycle as `AnthropicBackend`
- `listModels()` → static list: `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.0-flash`

#### `factory.ts` — `createBackend(providerConfig, clientOptions)`
```typescript
export function createBackend(
  provider: 'copilot' | 'anthropic' | 'gemini',
  options: SquadClientOptions
): ISquadClientBackend {
  switch (provider) {
    case 'anthropic': return new AnthropicBackend(options);
    case 'gemini':    return new GeminiBackend(options);
    default:          return new CopilotBackend(options);
  }
}
```

### Modified: `packages/squad-sdk/src/adapter/client.ts`

Add `provider` to `SquadClientOptions`:
```typescript
export interface SquadClientOptions {
  provider?: 'copilot' | 'anthropic' | 'gemini';  // NEW — default: 'copilot'
  anthropic?: { apiKey?: string; model?: string };  // NEW
  gemini?: { apiKey?: string; model?: string };     // NEW
  // ...all existing options unchanged
}
```

`SquadClient` constructor: replace `new CopilotClient(...)` + all delegate methods with:
```typescript
this.backend = createBackend(options.provider ?? 'copilot', options);
```
All public methods become thin wrappers that call `this.backend.*()`, keeping the existing OTel span wrapping in place.

### Modified: `packages/squad-sdk/src/config/schema.ts`

Add to `SquadConfig`:
```typescript
provider?: {
  type: 'copilot' | 'anthropic' | 'gemini';
  anthropic?: { apiKey?: string; defaultModel?: string };
  gemini?: { apiKey?: string; defaultModel?: string };
  copilot?: { cliPath?: string };
};
```

### Modified: `packages/squad-sdk/package.json`

Move `@github/copilot-sdk` to `optionalDependencies`. Add:
```json
"optionalDependencies": {
  "@github/copilot-sdk": "^0.1.32",
  "@anthropic-ai/sdk": "^0.90.0",
  "@google/genai": "^1.48.0"
}
```

### Modified: `packages/squad-cli/src/cli/shell/spawn.ts`

Read provider from config when constructing `SquadClient`:
```typescript
const client = new SquadClient({
  provider: squadConfig?.provider?.type ?? 'copilot',
  anthropic: squadConfig?.provider?.anthropic,
  gemini: squadConfig?.provider?.gemini,
  ...copilotOptions,
});
```

### Modified: `packages/squad-cli/src/cli/core/init.ts`

Add provider prompt to `squad init` flow (after team scaffolding):
```
Which LLM provider will power your squad?
  ❯ copilot   — GitHub Copilot (requires Copilot subscription + CLI)
    anthropic — Anthropic Claude (requires ANTHROPIC_API_KEY)
    gemini    — Google Gemini (requires GEMINI_API_KEY)
```
Write choice + any API key hints to `.squad/provider.json` (gitignored by default).

### New: `.squad/provider.json` (template, gitignored)
```json
{
  "type": "anthropic",
  "anthropic": {
    "apiKey": "${ANTHROPIC_API_KEY}",
    "defaultModel": "claude-sonnet-4-5"
  }
}
```

---

## Part 4: README Rewrite

### Structure
1. **Attribution header** — "Forked from [bradygaster/squad](https://github.com/bradygaster/squad). Original work by Brady Gaster and contributors."
2. **What's different in this fork** — multi-provider support, source-only build
3. **Provider support table** (Copilot / Anthropic / Gemini — features, models, requirements)
4. **Development setup** (replaces all npm install -g instructions):
   ```bash
   git clone https://github.com/DeDuva/squad
   cd squad
   npm install
   npm run build           # builds both packages
   # Add to PATH or alias:
   alias squad="node $(pwd)/packages/squad-cli/dist/cli-entry.js"
   ```
5. **Provider configuration** — how to set `squad init` provider choice and env vars
6. **Rest of original content** — preserved, with `@bradygaster/` package name refs replaced with source-path equivalents

### Specific removals
- All `npm install -g @bradygaster/squad-cli` → replaced with source build instructions
- All `npx @bradygaster/squad-cli` → replaced with `squad` (after local alias/link)
- SDK usage examples: `import from '@bradygaster/squad-sdk'` → `import from '@squad/sdk'`

---

## Critical Files

| File | Action |
|---|---|
| `packages/squad-sdk/src/adapter/client.ts` | Refactor to delegate to backend |
| `packages/squad-sdk/src/adapter/providers/base.ts` | **New** — ISquadClientBackend interface |
| `packages/squad-sdk/src/adapter/providers/copilot.ts` | **New** — extracted CopilotBackend |
| `packages/squad-sdk/src/adapter/providers/anthropic.ts` | **New** — AnthropicBackend + AnthropicSession |
| `packages/squad-sdk/src/adapter/providers/gemini.ts` | **New** — GeminiBackend + GeminiSession |
| `packages/squad-sdk/src/adapter/providers/factory.ts` | **New** — createBackend() |
| `packages/squad-sdk/src/config/schema.ts` | Add provider field |
| `packages/squad-sdk/package.json` | Move copilot-sdk to optional, add anthropic + gemini |
| `packages/squad-cli/package.json` | Rename @bradygaster scope |
| `packages/squad-cli/src/cli/core/init.ts` | Add provider prompt |
| `packages/squad-cli/src/cli/shell/spawn.ts` | Pass provider config to SquadClient |
| `README.md` | Full rewrite per above |
| All `*.ts` files with `@bradygaster/squad-sdk` imports | grep-replace to `@squad/sdk` |

---

## Verification

1. `npm run build` succeeds in both packages
2. `node packages/squad-cli/dist/cli-entry.js --version` runs
3. `squad init` with `anthropic` provider writes `.squad/provider.json`
4. `squad init` with `gemini` provider writes `.squad/provider.json`
5. `squad init` with `copilot` provider (default) behaves identically to current behavior
6. With a valid `ANTHROPIC_API_KEY`, running `squad` shell and sending a message receives a streamed response
7. No remaining `@bradygaster` references in source files (verify with grep)
8. TypeScript strict-mode compilation passes (no `any` escape hatches introduced)
