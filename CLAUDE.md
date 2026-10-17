# CLAUDE.md — squad (DeDuva fork)

This is `DeDuva/squad`, a fork of `bradygaster/squad` (`@deduvafork/squad`) being
replatformed to be **model- and harness-agnostic** rather than GitHub-Copilot-only, and
used as the host for two research packages of its own.

`CONTRIBUTING.md` and `README.md` are upstream's and describe upstream's project. This
file covers what is true of *the fork* and is not written down anywhere in the tree.

## Branching

- **The default branch is `dev`, not `main`.** Base new work on `dev` and open PRs into
  `dev`. (The old `replatform-0.11` line is spent — `dev` was made default on 2026-08-07
  at that branch's tip.)
- **GitHub does not treat this repo as a fork** — its `parent` is `null`, so `gh repo sync`
  does not work. There is an `upstream` remote (`bradygaster/squad`); fetch from it,
  never push to it.
- All work lands through a PR. Commit messages and PR bodies carry no AI attribution.

**Do not regenerate this file with `/init`.** A codebase scan would describe upstream's
project, which is exactly what this file exists to correct. Edit it by hand;
`npm run check:docs` fails if a path named here stops existing.

`.claude/settings.json` is checked in and holds the shared permission allowlist.
`.claude/settings.local.json` is for personal, machine-specific entries and is ignored —
it used to be committed, carrying one contributor's PowerShell one-liners into the repo.

## Layout

npm workspaces monorepo, `packages/*`. Node **≥22.5.0** (`engines`) — `CONTRIBUTING.md`
still says ≥20; believe `package.json`. That mismatch is **upstream's**, not the fork's,
and is deliberately left uncorrected here: upstream-owned files stay byte-identical so the
fork's diff remains small and the next sync stays conflict-free. Fix it upstream, not here.

| Package | Origin |
|---|---|
| `packages/squad-sdk`, `packages/squad-cli` | upstream — keep the diff against upstream small and intentional |
| `packages/squad-lab` | **fork-added.** Goal-setting + cross-provider A/B frontend; an A/B test is one ADP intent and N runs |
| `packages/duva-bench` | **fork-added.** The squad track of duva-bench; `PLAN.md` inside it is that track's plan of record |

Fork-added ADP integration lives in `packages/squad-sdk/src/adp/` — `recorder.ts` and
`spool.ts` subscribe to squad's own events and record runs to ADP without blocking them.

## Fork deviations from upstream

Every place the fork deliberately differs from an upstream-owned file or upstream's
repository setup. Keep this list complete — it is what the next upstream sync has to
reconcile.

- **`.github/workflows/squad-ci.yml`** — the `pull_request` trigger drops `edited` from
  `types`. Upstream re-runs the whole CI on every PR title/body edit; nothing in the
  workflow reads the title or body, so here that was pure Actions spend. One line; on
  an upstream sync, keep the fork's line.
- **`.github/dependabot.yml`** — rewritten for the fork: npm `/` and github-actions only,
  monthly, at most 3 open PRs, minor+patch grouped and majors grouped separately. The
  NuGet and `/docs` entries are gone — the fork ships neither. vitest majors are
  ignored until squad-lab moves to vitest 5.
- **Upstream-only workflows are disabled in GitHub, not edited** (2026-10-17). Their
  files stay byte-identical so syncs stay conflict-free; the state lives in the repo's
  Actions settings (`gh workflow list --all`). Disabled: every `squad-*.yml` except
  `squad-ci.yml`, plus `sync-squad-labels.yml` — triage/labels/nudges/heartbeat,
  impact/readiness/scope/repo-health, the npm/insider/NuGet publish and release/promote
  pipelines, the Astro docs build and link check, preview validation, and the
  `Squad.Agents.AI` .NET CI. **Active:** `fork-checks.yml` (provides required check
  `claude-md`), `squad-ci.yml` (provides required check `changes`, plus `test`),
  `pages.yml`, and GitHub's dynamic Dependabot Updates / Dependency Graph. A workflow
  that a sync *adds* arrives enabled — disable it unless the fork needs it. Re-enable
  one with `gh workflow enable <file> -R DeDuva/squad`.

## Commands

```bash
npm run check     # the gate: check:docs + lint + test
npm test          # vitest run
npm run lint      # tsc --noEmit across squad-sdk and squad-cli
npm run build     # squad-sdk then squad-cli (prebuild wipes dist/ and re-syncs templates)
npm run -w @deduvafork/squad-lab lab      # the lab CLI
npm run -w @deduvafork/squad-lab web:dev  # the lab web UX
```

**Build before trusting a test result.** A stale `dist/` predating the vendor registry
once hid 24 real failures — tests ran green against output that no longer matched the
source.

## Why this fork talks to ADP

`packages/squad-sdk/src/platform/github.ts` wraps the **`gh` CLI**, and ADP's locked
success criterion is that unmodified `gh` works against it via `GH_HOST`. So squad runs
against ADP with **zero code changes**, and the two projects are each other's test
fixture: squad is a realistic multi-agent conformance workload for ADP, and ADP is a
hermetic GitHub stand-in for squad's tests.

Gaps that squad finds in ADP are **report-only evidence** for ADP's milestone ledger —
file them there; they do not change ADP's scope by themselves, and they are not fixed by
patching around them here.

## Dependency automation

`.github/prompts/dependabot-review.md` is the prompt a weekly Claude routine runs to
triage, validate, and merge Dependabot PRs. It encodes facts about *this* repository
that are easy to get wrong — chiefly that `dev`'s two required checks (`claude-md`,
`changes`) are the only unconditionally-running jobs here, so a green
`mergeStateStatus` proves a PR is fresh, not that the update was tested. Re-verify its
"Repository facts" table whenever branch protection or `.github/workflows/` changes.

## Where the plans live

- **`ROADMAP.md`** — the single status ledger for the fork and both research packages:
  milestone states, gates, open decisions. A PR that changes milestone status updates
  it in the same PR.
- The squad-track bench plan: `packages/duva-bench/PLAN.md` (in-tree). It decides that
  track's scope.
- **Milestone reports and the cross-project plan moved off disk** to the private
  `github.com/DeDuva/duva-lab-tpm`. `~/dev/duva_squad/PLAN.md` and `~/dev/duva_squad/reports/`
  were deleted after the remote was verified byte-identical — don't go looking for them
  locally.
- Vendor API keys for lab runs are in `~/.config/squad/`. The AI-SDK harness needs a key;
  squad's native backend does not.
