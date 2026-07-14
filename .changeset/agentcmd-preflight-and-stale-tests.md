---
"@bradygaster/squad-cli": patch
---

fix(cli): validate the configured `--agent-cmd` binary before starting `squad loop`

Previously, setting `--agent-cmd` skipped preflight validation entirely, so a
typo'd or missing custom agent binary only surfaced as a confusing failure
mid-round. `squad loop` now runs a `checkAgentCli` preflight (mirroring the
existing Copilot CLI check, including Windows `.cmd` shim and timeout
handling) and fails fast with a clear "Agent command not found" error.

Also removes `test/squad-route-factory.test.ts` (tested a `sessionFactory`
callback API superseded by `fanOutDepsGetter` during the upstream-sync replay,
already covered by `test/sdk/squad-route.test.ts`) and reconciles
`test/cli/rc.test.ts`'s stale "agent passthrough" assertions with `rc.ts`'s
current hardcoded-Copilot implementation.
