---
"@squad/sdk": patch
"@squad/cli": patch
---

Fix Anthropic (and Gemini) provider end-to-end wiring in the interactive shell.

- Shell now reads `.squad/provider.json` via `loadProviderConfig` instead of defaulting to Copilot
- `AnthropicBackend.isConnected()` and `GeminiBackend.isConnected()` now return `false` until `connect()` is called, enabling `SquadClient` autoStart to work correctly
- `awaitStreamedResponse` handles plain-string `sendAndWait` results from Anthropic/Gemini (was only handling Copilot's `{ data: { content } }` shape)
- `squad init` now prompts for API key and writes it to `.squad/provider.json` (gitignored)
- Update default Anthropic model to `claude-sonnet-4-6` and model list to current IDs
- Fix "Copilot agent prompt" landmark label to provider-agnostic "Agent prompt"
