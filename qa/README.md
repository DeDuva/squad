# Squad — This Fork

[English](README.md) | [中文](README.zh.md)

**Human-led AI agent teams for any project.** One command. A team of specialists that lives in your repo, learns your codebase, and helps you move faster without giving up control.

[![Status](https://img.shields.io/badge/status-alpha-blueviolet)](#status)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5.0-green)](#prerequisites)

> ⚠️ **Alpha Software.** APIs and CLI commands may change between releases. Breaking changes are documented in [CHANGELOG.md](../CHANGELOG.md).
>
> This is the **DeDuva/squad** fork. PRs target the `dev` branch of this fork, not the upstream `bradygaster/squad` repo.

---

## What is Squad?

Squad gives you a human-directed AI development team. Describe your project. Get a named team of specialists — frontend, backend, tester, lead — that persist in your repo as files. They accumulate project knowledge across sessions, share decisions, and work in parallel while you keep priorities, approvals, and final changes.

Squad is a coordination layer, not an autonomous agent. **You direct. Squad delegates.** Each team member runs in its own context, writes back what it learned, and everything stays in git — inspectable, diffable, committable.

---

## How Squad Works

```
You → Coordinator (squad.agent.md)
           ↓ routes to
   ┌──────────────────────────────────┐
   │  🏗️  Lead    ⚛️  Frontend         │
   │  🔧  Backend  🧪  Tester          │  ← each is a real agent spawn
   │  📋  Scribe   🔄  Ralph           │
   └──────────────────────────────────┘
           ↓ writes to
   .squad/
   ├── decisions.md    (shared team brain)
   ├── agents/{name}/
   │   ├── charter.md  (who I am)
   │   └── history.md  (what I know about YOUR project)
   └── orchestration-log/
```

The **Coordinator** (`squad.agent.md`) is the only agent you talk to. It reads your message, decides who should work on it, spawns those agents in parallel, collects their results, and logs everything. You never talk to individual agents directly — the Coordinator routes everything.

**State lives in git.** Anyone who clones your repo gets the team — with all accumulated knowledge.

---

## Architecture

Squad is a TypeScript monorepo with two npm packages:

| Package | Description |
|---------|-------------|
| `@bradygaster/squad-sdk` | Core runtime — agent orchestration, tool registry, hooks pipeline, casting engine, Ralph polling |
| `@bradygaster/squad-cli` | CLI binary (`squad` command) — wraps the SDK with a terminal interface |

**Node.js ≥22.5.0 is required** for `node:sqlite` support used in session storage.

---

## Happy Path — Build from Source and Use in Your Project

### Step 1: Clone the repo and build

```bash
git clone https://github.com/DeDuva/squad.git
cd squad
npm install
```

> ⚠️ **Known build issue:** If `npm install` left a stale copy of the SDK inside the CLI package, the build will fail with TypeScript errors about missing exports. Fix it before building:
>
> ```bash
> rm -rf packages/squad-cli/node_modules/@bradygaster/squad-sdk
> ```

```bash
npm run build
```

Verify the build:

```bash
node packages/squad-cli/dist/cli-entry.js --version
# Expected: 0.9.4-build.X
```

### Step 2: Create your project

In a **separate directory** (not inside the squad repo):

```bash
mkdir my-project
cd my-project
git init
```

### Step 3: Initialize Squad in your project

```bash
node /path/to/squad/packages/squad-cli/dist/cli-entry.js init
```

Or, if you want to use the `squad` command by name everywhere, link it globally:

```bash
# From the squad source directory
npm link -w packages/squad-cli
```

Then from your project:

```bash
squad init
```

**What `squad init` creates:**

```
my-project/
├── .github/
│   ├── agents/
│   │   └── squad.agent.md         ← The Coordinator (the only agent you talk to)
│   └── workflows/
│       ├── squad-heartbeat.yml    ← GitHub Actions automation
│       ├── squad-issue-assign.yml
│       ├── squad-triage.yml
│       └── sync-squad-labels.yml
├── .gitattributes                 ← merge=union for append-only files
├── .squad/
│   ├── agents/
│   │   ├── ralph/                 ← Work monitor
│   │   └── scribe/                ← Session logger
│   ├── casting/
│   │   ├── history.json
│   │   ├── policy.json
│   │   └── registry.json
│   ├── identity/
│   │   ├── now.md
│   │   └── wisdom.md
│   ├── skills/
│   ├── templates/                 ← Reference files for agent prompts
│   ├── ceremonies.md
│   ├── config.json
│   ├── decisions.md
│   ├── mcp-config.json
│   ├── routing.md
│   └── team.md
```

**✓ Validate:** Run `squad doctor` and confirm all checks pass.

> ⚠️ **Known issue:** `squad doctor` will report "squad.js bundle — not found" when run from your project. This is a false positive — the check is designed for development inside the Squad source repo. Ignore it. All other checks should pass.

### Step 4: Authenticate with GitHub (for Issues, PRs, and Ralph)

```bash
gh auth login
```

**✓ Validate:** `gh auth status` should show "Logged in to github.com."

### Step 5: Open GitHub Copilot and go

In VS Code, open Copilot Chat and select the **Squad** agent.

Or from the terminal:

```bash
copilot --agent squad --yolo
```

> **Why `--yolo`?** Squad makes many tool calls per session. Without it, Copilot prompts you to approve each one, which is disruptive for multi-agent parallel work.

Then describe your project:

```
I'm starting a new project — a recipe sharing app with React and Node.
Set up the team.
```

**✓ Validate:** Squad proposes a named team. Type `yes` to confirm. Your `.squad/team.md` now has a roster.

---

## What Squad Does in Your Repo

Squad operates **exclusively in your project directory**. Everything it creates or modifies is under:

- `.squad/` — Team state (decisions, agent knowledge, logs)
- `.github/agents/squad.agent.md` — Coordinator prompt
- `.github/workflows/squad-*.yml` — Optional GitHub Actions
- `.gitattributes` — Merge driver configuration

Squad writes nothing outside your project directory. The Squad source repo is not touched after installation.

---

## Committing Squad State

**Commit `.squad/` to git.** This is how the team persists across sessions, machines, and collaborators.

```bash
git add .squad/ .github/ .gitattributes
git commit -m "Init Squad team"
```

Anyone who clones your repo gets the full team — with accumulated project knowledge.

---

## All Commands

| Command | What it does |
|---------|-------------|
| `squad init` | Scaffold Squad in the current directory (idempotent — safe to run multiple times). Alias: `hire`. Use `--global` for personal squad, `--mode remote <path>` for dual-root mode. |
| `squad upgrade` | Update Squad-owned files to the latest version. Never touches your `.squad/` team state. Use `--force` to re-apply. |
| `squad upgrade --self` | Update the Squad CLI package itself. Add `--insider` for prerelease. |
| `squad status` | Show which squad is active and why. |
| `squad triage` | Watch mode — poll for issues and auto-triage to team. Aliases: `watch`, `loop`. Use `--interval <minutes>` (default: 10), `--execute` to dispatch agents, `--health` for status. |
| `squad doctor` | Check your setup and diagnose issues. Alias: `heartbeat`. |
| `squad copilot` | Add/remove the GitHub Copilot coding agent. Use `--off` to remove, `--auto-assign` for auto-assignment. |
| `squad link <team-repo-path>` | Connect to a remote team. |
| `squad externalize` | Move `.squad/` state outside the working tree. Survives branch switches. |
| `squad internalize` | Move externalized state back into `.squad/`. |
| `squad export` | Export squad to a portable JSON snapshot. |
| `squad import <file>` | Import squad from an export file. |
| `squad nap` | Compress and prune squad state. Use `--deep` for aggressive compression, `--dry-run` to preview. |
| `squad aspire` | Open the Aspire dashboard for observability. |
| `squad scrub-emails [dir]` | Remove email addresses from Squad state files. |
| `squad roles` | List all built-in agent roles. |
| `squad cast` | Manage agent casting (the fictional naming system). |
| `squad personal` | Manage your personal (ambient) squad. |
| `squad preset` | Apply a preset to scaffold common team configurations. |
| `squad shell` | *(Deprecated)* Launch an interactive shell. Use `copilot --agent squad` instead. |
| `squad plugin marketplace add\|remove\|list\|browse` | Manage plugin marketplaces. |
| `squad upstream add\|remove\|list\|sync` | Manage upstream Squad sources. |

---

## Watch Mode — Ralph

Ralph is Squad's built-in work monitor. He polls GitHub Issues, triages them to team members, and drives agents to pick them up — without you having to manually assign work.

```bash
# Triage only — no agent execution
squad triage

# Triage and execute (spawns Copilot agents for actionable issues)
squad triage --execute --interval 5

# Custom agent command
squad triage --execute \
  --agent-cmd "gh copilot" \
  --copilot-flags "--yolo --autopilot --agent squad" \
  --interval 10

# Check health of a running watch process
squad triage --health
```

**How Ralph decides what to work on:**

1. Scans GitHub for issues with `squad` labels
2. Routes untriaged issues to the Lead for triage
3. Spawns agents for issues labeled `squad:{member-name}`
4. Polls CI, PR review status, and merge readiness
5. Auto-merges approved PRs (when configured)

**Stopping Ralph:**

```bash
touch .squad/ralph-stop
# Watch finishes the current round and exits cleanly
```

**4-tier error recovery:**

| Tier | Action |
|------|--------|
| 1 | Reset circuit breaker and retry |
| 2 | Re-verify GitHub authentication |
| 3 | `git pull` to sync local state |
| 4 | Pause 30 minutes for human intervention |

---

## Security Design

Squad is built around the principle of minimal blast radius. The Coordinator never performs domain work itself; it only dispatches to specialist agents. Each agent:

1. **Reads only what it's given.** Charter, history, decisions, and specific input files. No agent reads other agents' histories.
2. **Writes to a drop-box, not directly to shared files.** Decisions are written to `.squad/decisions/inbox/{name}-{slug}.md`. The Scribe merges them. This eliminates write conflicts and ensures the decision log stays consistent.
3. **Has no credentials.** The workstation tool bundle strips sensitive environment variables (any env var whose name matches `token|secret|key|password|credential|auth|api`) before executing shell commands.

### Workstation Tool Security Model

When Squad uses the workstation tools (bash, file I/O, directory listing), these protections are enforced:

| Protection | How |
|-----------|-----|
| **Path confinement** | All file operations must resolve within `rootDir`. Symlinks are followed and checked — a symlink pointing outside `rootDir` is blocked. |
| **Path traversal** | `../../etc/passwd` is blocked before any I/O occurs. Fast pre-check catches `..` components; symlink resolution catches more subtle attacks. |
| **Env sanitisation** | Before each shell command, a clean environment is constructed: sensitive var names stripped, `NODE_OPTIONS`/`LD_PRELOAD`/`LD_LIBRARY_PATH`/`DYLD_*` always removed. |
| **Timeout enforcement** | Default 30 seconds. Agent-supplied timeouts are clamped to the host ceiling and cannot be zero or negative. |
| **Process group kill** | On Unix, timeout kills the entire process group (catches `&` and `nohup` backgrounds). On Windows, `taskkill /F /T` kills the process tree. |
| **Write cap** | 10 MB per file. Prevents disk exhaustion. |
| **Binary rejection** | Binary files (detected by null bytes in the first 8 KB) are rejected on read. |
| **Output truncation** | Combined stdout+stderr capped at 100 KB. |
| **Directory limits** | Directory listing: 1,000 entries max. File search: 500 results max. |

### Known Security Limitations

| Limitation | Impact |
|-----------|--------|
| `setsid()` escape on Unix | A process that explicitly calls `setsid()` can escape the process group kill on timeout. Full containment requires OS-level sandboxing (containers, `seccomp`). |
| No shell command allowlist | The workstation bash tool does not restrict which commands can be run. Use the `onPreToolUse` hook to add a command allowlist. |
| `rootDir` not enforced by default | If `rootDir` is omitted when creating workstation tools, no path confinement is applied. Always set `rootDir` in production. |
| Personal squad agents | Personal agents operate under Ghost Protocol (read-only project state) but this is enforced by prompt instructions, not by code. A misconfigured personal agent could write to project files. |
| Stale env snapshot | The safe environment is captured once when `createWorkstationTools()` is called. Sensitive env vars added after that call are not stripped. |

---

## SDK-First Mode (Experimental)

Instead of the default markdown-based team definition, you can define your team in TypeScript:

```typescript
// squad.config.ts
import { defineSquad, defineTeam, defineAgent } from '@bradygaster/squad-sdk';

export default defineSquad({
  team: defineTeam({ name: 'Platform Squad', members: ['@edie', '@mcmanus'] }),
  agents: [
    defineAgent({ name: 'edie', role: 'TypeScript Engineer', model: 'claude-sonnet-4.6' }),
    defineAgent({ name: 'mcmanus', role: 'DevRel', model: 'claude-haiku-4.5' }),
  ],
});
```

Then run `squad build` to generate `.squad/` from your config.

> ⚠️ SDK-first mode is experimental. Use markdown-first (the default) for production teams.

---

## Upgrading

```bash
# Step 1: Update CLI (if installed globally)
npm install -g @bradygaster/squad-cli@latest

# Step 2: Update Squad-owned files in your project
squad upgrade
```

`squad upgrade` refreshes `squad.agent.md`, templates, and GitHub workflows. It never touches your `.squad/agents/`, `.squad/decisions.md`, or any team state.

---

## Edge Cases

### Running in a git worktree

Squad supports git worktrees. Each worktree can have its own `.squad/` state (worktree-local strategy) or share state from the main checkout (main-checkout strategy).

The Coordinator auto-detects which worktree it's in and passes `TEAM_ROOT` to all spawned agents. Do not change branches from inside an agent session.

### Running without a GitHub account

Most Squad features work without GitHub. The following features require `gh auth login`:

- Issue-driven workflow (Ralph, `squad triage --execute`)
- PR creation and merge
- GitHub Actions workflows
- `@copilot` team member

Core features — init, agent sessions, decisions, history, export/import — work without GitHub.

### Running on Windows

Squad is tested on Windows. The workstation bash tool uses `cmd.exe` by default on Windows. Note:

- `cmd.exe` has different quoting rules than bash
- Process kill on timeout uses `taskkill /F /T` (process tree kill)
- Path separators in agent output may be `\` instead of `/`

For a more consistent cross-platform shell experience, you can override the shell:

```typescript
createWorkstationTools({ shell: 'powershell.exe -Command', rootDir: '...' })
```

### SQUAD_TEAM_ROOT environment variable

Override the `.squad/` root path for monorepo setups:

```bash
SQUAD_TEAM_ROOT=/path/to/shared/squad-state squad init
```

> ⚠️ If `SQUAD_TEAM_ROOT` points to a non-existent path, `squad status` and `squad doctor` may behave unexpectedly. This is a known edge case.

### Multiple humans on a team

Humans can be added to the squad roster. They appear in routing but are not spawnable — the Coordinator presents work and waits for their input. Use:

```
Add Brady as a PM reviewer.
```

### Externalizing team state

If you're working across branches and don't want `.squad/` state to change with each checkout:

```bash
squad externalize
```

This moves `.squad/` outside your git working tree. The state persists across branch switches.

---

## Building from Source (for Contributors)

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full guide.

**Quick start:**

```bash
npm install
# Fix workspace link if needed:
rm -rf packages/squad-cli/node_modules/@bradygaster/squad-sdk
npm run build

# Run tests
npm test

# Watch mode for development
npm run dev

# Type check only (no emit)
npm run lint
```

---

## Status

Squad is alpha software. The core features work. Known issues:

| Issue | Status |
|-------|--------|
| Build fails without `rm -rf packages/squad-cli/node_modules/@bradygaster/squad-sdk` | Documented workaround; P0 fix pending |
| `squad doctor` false positive for "squad.js bundle" in user projects | Documented; P0 fix pending |
| `squad copilot` and `squad copilot-bridge` commands not implemented | P1 fix pending |
| 86 failing tests (model catalog, skill source, casting overflow, others) | P1 fix pending |
| Casting engine crashes on small universes (usual-suspects + scribe) | P2 fix pending |

File issues at: https://github.com/DeDuva/squad/issues
