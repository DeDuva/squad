---
"@squad/sdk": minor
"@squad/cli": minor
---

Add pluggable multi-provider LLM support (Anthropic Claude and Google Gemini alongside GitHub Copilot).

- New `ISquadClientBackend` interface with `CopilotBackend`, `AnthropicBackend`, and `GeminiBackend` implementations
- Provider selected during `squad init` and stored in `.squad/provider.json`
- Rename internal packages from `@bradygaster/` scope to `@squad/` scope
- Switch to source-only distribution model; self-update checks GitHub commits API
