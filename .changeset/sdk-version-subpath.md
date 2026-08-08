---
"@bradygaster/squad-sdk": minor
---

Add a `./version` subpath export: an import-free module exporting the SDK version and nothing else.

Reading the version previously meant importing the root barrel, which re-exports the whole public API including the coordinator. Consumers that must not reach the coordinator — duva-bench enforces this as a test — had no way to record which SDK produced a run. The barrel now re-exports this module rather than reading `package.json` a second time, so there is one source of truth.
