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

## Layout

npm workspaces monorepo, `packages/*`. Node **≥22.5.0** (`engines`) — `CONTRIBUTING.md`
still says ≥20; believe `package.json`.

| Package | Origin |
|---|---|
| `packages/squad-sdk`, `packages/squad-cli` | upstream — keep the diff against upstream small and intentional |
| `packages/squad-lab` | **fork-added.** Goal-setting + cross-provider A/B frontend; an A/B test is one ADP intent and N runs |
| `packages/duva-bench` | **fork-added.** The squad track of duva-bench; `PLAN.md` inside it is that track's plan of record |

Fork-added ADP integration lives in `packages/squad-sdk/src/adp/` — `recorder.ts` and
`spool.ts` subscribe to squad's own events and record runs to ADP without blocking them.

## Commands

```bash
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

## Where the plans live

- The squad-track bench plan: `packages/duva-bench/PLAN.md` (in-tree).
- **Milestone reports and the cross-project plan moved off disk** to the private
  `github.com/DeDuva/duva-lab-tpm`. `~/dev/duva_squad/PLAN.md` and `~/dev/duva_squad/reports/`
  were deleted after the remote was verified byte-identical — don't go looking for them
  locally.
- Vendor API keys for lab runs are in `~/.config/squad/`. The AI-SDK harness needs a key;
  squad's native backend does not.
