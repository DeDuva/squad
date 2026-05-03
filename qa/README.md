# Squad — DeDuva Fork

[English](README.md)

**Human-led AI agent teams for any project.** One command. A team of specialists that lives in your repo, learns your codebase, and helps you move faster without giving up control.

[![Status](https://img.shields.io/badge/status-alpha-blueviolet)](#status)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5.0-green)](#prerequisites)

> **This is the DeDuva/squad fork.** It has two goals vs the upstream (bradygaster/squad):
>
> 1. **Gemini-native** — the LLM runtime runs on Google Gemini, with no dependency on `@github/copilot-sdk`.
> 2. **Airgap / build-from-source** — no dependency on bradygaster's published npm binaries. You clone, build, and link locally.
>
> PRs target the `dev` branch of this fork (`DeDuva/squad:dev`), not `bradygaster/squad`.

---

## What is Squad?

Squad gives you a human-directed AI development team. Describe your project. Get a named team of specialists — frontend, backend, tester, lead — that persist in your repo as files. They accumulate project knowledge across sessions, share decisions, and work in parallel while you keep priorities, approvals, and final changes.

Squad is a **coordination layer**, not an autonomous agent. **You direct. Squad delegates.** Each team member runs in its own context, writes back what it learned, and everything stays in git — inspectable, diffable, committable.

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
   ├── decisions.md      (shared team brain)
   ├── agents/{name}/
   │   ├── charter.md    (who I am)
   │   └── history.md    (what I know about YOUR project)
   └── orchestration-log/
```

The **Coordinator** (`.github/agents/squad.agent.md`) is the only agent you talk to. It reads your message, decides who should work on it, spawns those agents in parallel, collects their results, and logs everything. You never talk to individual agents directly.

**State lives in git.** Anyone who clones your repo gets the team — with all accumulated knowledge.

---

## Architecture

Squad is a TypeScript monorepo with two npm packages:

| Package | Description |
|---------|-------------|
| `@deduvafork/squad-sdk` | Core runtime — agent orchestration, Gemini client, tool registry, hooks pipeline, casting engine, Ralph polling |
| `@deduvafork/squad-cli` | CLI binary (`squad` command) — wraps the SDK with a terminal interface |

**Node.js ≥22.5.0 is required** for `node:sqlite` support used in session storage.

---

## Prerequisites

- **Node.js ≥22.5.0** — `node --version` to verify
- **Git** — `git --version` to verify
- **A Google Gemini API key** — get one at https://aistudio.google.com/app/apikey
- **GitHub CLI** (`gh`) — only required for issue-driven workflow (Ralph, `squad triage --execute`)
- **An AI coding agent** that can load `squad.agent.md` — e.g., GitHub Copilot in VS Code, or any agent that reads `.github/agents/`

---

## Happy Path — Build from Source and Use in Your Project

### Step 1: Clone and build Squad

```bash
git clone https://github.com/DeDuva/squad.git
cd squad
npm install
npm run build
```

Verify the build succeeded:

```bash
node packages/squad-cli/dist/cli-entry.js --version
# Expected: 0.9.4-build.X
```

### Step 2: Configure your Gemini API key

```bash
node packages/squad-cli/dist/cli-entry.js auth setup --provider=gemini --key YOUR_GEMINI_API_KEY
```

Or set the environment variable:

```bash
export GEMINI_API_KEY=YOUR_GEMINI_API_KEY
```

### Step 3: Create your project (separate directory)

```bash
mkdir my-project
cd my-project
git init
```

> **Squad must be initialized in a git repository.** It uses git to determine the project root and to manage `.gitattributes` merge drivers.

### Step 4: Initialize Squad in your project

```bash
node /path/to/squad/packages/squad-cli/dist/cli-entry.js init
```

Or link globally so you can use `squad` anywhere:

```bash
# From inside the cloned squad directory
npm link -w packages/squad-cli

# Then from your project
squad init
```

**What `squad init` creates:**

```
my-project/
├── .github/
│   ├── agents/
│   │   └── squad.agent.md          ← The Coordinator (the only agent you talk to)
│   └── workflows/
│       ├── squad-heartbeat.yml     ← GitHub Actions automation
│       ├── squad-issue-assign.yml
│       ├── squad-triage.yml
│       └── sync-squad-labels.yml
├── .gitattributes                  ← merge=union for append-only files
├── .gitignore
└── .squad/
    ├── agents/
    │   ├── ralph/                  ← Work monitor
    │   └── scribe/                 ← Session logger
    ├── casting/                    ← Agent identity system
    ├── decisions.md                ← Shared team decision log
    ├── decisions/inbox/            ← Drop-box for decision proposals
    ├── identity/                   ← Squad personality state
    ├── skills/                     ← Built-in skill modules
    ├── templates/                  ← Reference files for agent prompts
    ├── config.json                 ← Squad configuration
    ├── mcp-config.json             ← MCP server configuration
    ├── routing.md                  ← Agent routing rules
    └── team.md                     ← Team roster
```

### Step 5: Validate with doctor

```bash
squad doctor
```

Expected output (with Gemini API key configured):

```
✅  .squad/ directory exists
✅  config.json valid
✅  team.md found with ## Members header
✅  routing.md found
✅  agents/ directory exists
✅  casting/registry.json exists
✅  decisions.md exists
✅  .github/agents/squad.agent.md
✅  Node.js ≥22.5.0
✅  Gemini API key — valid

❌  squad.js bundle — not found     ← FALSE POSITIVE: safe to ignore
                                        (this check is only meaningful inside
                                         the Squad source repo itself)

Summary: 10 passed, 1 failed
```

> **Known issue:** The `squad.js bundle` check always fails in user projects — it looks for a build artifact inside the Squad source tree. It does **not** affect Squad's ability to run. This is a P1 fix in progress. See [Recommendations](#recommendations).

### Step 6: Commit Squad state to git

```bash
git add .squad/ .github/ .gitattributes .gitignore
git commit -m "Init Squad team"
```

Anyone who clones your repo gets the full team — with all accumulated project knowledge.

### Step 7: Open your AI coding agent and go

In VS Code, open GitHub Copilot Chat and select the **Squad** agent (it reads `.github/agents/squad.agent.md`).

Then describe your project:

```
I'm starting a new project — a recipe sharing app with React and Node.
Set up the team.
```

Squad will propose a named team. Type `yes` to confirm. Your `.squad/team.md` now has a roster.

---

## Configuring Models

Squad uses Google Gemini exclusively. The model resolution follows a 5-layer hierarchy:

| Layer | Source | Example |
|-------|--------|---------|
| 0a | Per-agent override in `.squad/config.json` | `{ "agentModelOverrides": { "backend": "gemini-2.5-pro" } }` |
| 0b | Global default in `.squad/config.json` | `{ "defaultModel": "gemini-2.5-flash" }` |
| 1 | Session directive | "Always use Flash for this session" |
| 2 | Agent charter | `## Model: gemini-2.5-pro` in charter.md |
| 3 | Task-aware auto | Code tasks → standard; docs → fast |
| 4 | Fallback | `gemini-2.5-flash-preview-04-17` |

### Available Models

| Tier | Model | Best for |
|------|-------|----------|
| Premium | `gemini-2.5-pro-preview-05-06` | Complex architecture, reasoning |
| Premium | `gemini-2.5-pro` | Complex architecture, reasoning |
| Standard | `gemini-2.5-flash-preview-04-17` | Code tasks (default) |
| Standard | `gemini-2.5-flash` | Code tasks |
| Fast | `gemini-2.0-flash` | Docs, routing, lightweight tasks |
| Fast | `gemini-2.0-flash-lite` | High-volume, cheap tasks |

Economy mode maps premium models to cheaper equivalents:

```json
// .squad/config.json
{ "economyMode": true }
```

---

## All Commands

| Command | What it does |
|---------|-------------|
| `squad init` | Scaffold Squad in the current directory (idempotent). Alias: `hire`. |
| `squad auth setup --provider=gemini --key KEY` | Store Gemini API key. |
| `squad doctor` | Check your setup and diagnose issues. Alias: `heartbeat`. |
| `squad upgrade` | Refresh Squad-owned files (templates, workflows). Never touches your team state. |
| `squad status` | Show which squad is active and why. |
| `squad triage` | Watch mode — poll GitHub Issues and triage to team. Aliases: `watch`, `loop`. |
| `squad export` | Export squad to a portable JSON snapshot. |
| `squad import <file>` | Import squad from an export file. |
| `squad nap` | Compress and prune squad state. |
| `squad roles` | List all built-in agent roles. |
| `squad cast` | Manage agent casting (fictional character names). |
| `squad personal` | Manage your personal (ambient) squad. |
| `squad cost` | Show session cost estimates. |
| `squad aspire` | Open the Aspire observability dashboard. |
| `squad scrub-emails [dir]` | Remove email addresses from Squad state files. |
| `squad link <team-repo-path>` | Connect to a remote team. |
| `squad externalize` | Move `.squad/` state outside the working tree (survives branch switches). |
| `squad internalize` | Move externalized state back into `.squad/`. |

> **Deprecated:** `squad shell`, `squad start` — these relied on GitHub Copilot's PTY interface. Use `copilot --agent squad` instead.

---

## Watch Mode — Ralph

Ralph is Squad's built-in work monitor. He polls GitHub Issues, triages them, and can spawn agents automatically.

```bash
# Triage only — classify issues, no agent execution
squad triage

# Triage and execute (spawns an agent CLI for actionable issues)
squad triage --execute --interval 5

# Custom agent command (default is 'copilot')
squad triage --execute \
  --agent-cmd "gh copilot" \
  --copilot-flags "--yolo --autopilot --agent squad" \
  --interval 10

# Check health of a running watch process
squad triage --health
```

> **Note:** `squad triage --execute` requires an agent CLI runner installed on your machine. The default is `copilot` (GitHub Copilot CLI). You can substitute any agent runner that accepts a prompt. This is **not** needed for basic squad usage — only for autonomous issue triage.

**Stopping Ralph:**

```bash
touch .squad/ralph-stop
# Watch finishes the current round and exits cleanly
```

---

## How Squad Operates in Your Repo

Squad operates **exclusively in your project directory**. Everything it creates or modifies is under:

- `.squad/` — Team state (decisions, agent knowledge, logs)
- `.github/agents/squad.agent.md` — Coordinator prompt
- `.github/workflows/squad-*.yml` — Optional GitHub Actions
- `.gitattributes` — Merge driver configuration

Squad writes **nothing outside your project directory**. The Squad source repo is never touched after installation.

---

## Security Design

Squad is built around the principle of minimal blast radius. The Coordinator never performs domain work itself — it only dispatches to specialist agents. Each agent:

1. **Reads only what it's given.** Charter, history, decisions, and specific input files. No agent reads other agents' histories.
2. **Writes to a drop-box, not directly to shared files.** Decision proposals go to `.squad/decisions/inbox/{name}-{slug}.md`. The Scribe merges them. This eliminates write conflicts and ensures the decision log stays consistent.
3. **Has no credentials.** The workstation tool bundle strips sensitive environment variables (any name matching `token|secret|key|password|credential|auth|api`) before executing shell commands.

### Workstation Tool Security Model

When Squad uses the workstation tools (bash, file I/O, directory listing), these protections are enforced at the code level in `packages/squad-sdk/src/tools/workstation.ts`:

| Protection | Mechanism |
|-----------|-----------|
| **Path confinement** | All file operations resolve within `rootDir`. Symlinks are followed and their resolved paths checked — a symlink pointing outside `rootDir` is blocked. |
| **Path traversal** | `../../etc/passwd` patterns are blocked before any I/O. Fast pre-check catches `..` components; symlink resolution catches subtler attacks. |
| **Env sanitisation** | Before each shell command, a clean environment is built: names matching `token\|secret\|key\|password\|credential\|auth\|api` are stripped. `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_FORCE_FLAT_NAMESPACE` are always removed. |
| **Timeout enforcement** | Default 30 seconds. Agent-supplied timeouts are clamped to the host ceiling and cannot be zero or negative. |
| **Process group kill** | On Unix, timeout kills the entire process group (catches backgrounded processes). On Windows, `taskkill /F /T` kills the process tree. |
| **Write cap** | 10 MB per file. Prevents disk exhaustion. |
| **Binary rejection** | Binary files (detected by null bytes in the first 8 KB) are rejected on read. |
| **Output truncation** | Combined stdout+stderr capped at 100 KB. |
| **Directory limits** | Directory listing: 1,000 entries max. File search: 500 results max. |

### Known Security Limitations

| Limitation | Impact |
|-----------|--------|
| `setsid()` escape on Unix | A process that calls `setsid()` can escape the process group kill on timeout. Full containment requires OS-level sandboxing (containers, `seccomp`). |
| No shell command allowlist | The workstation bash tool does not restrict which commands agents can run. Use the `onPreToolUse` hook to add an allowlist. |
| `rootDir` not enforced by default | If `rootDir` is omitted when creating workstation tools, no path confinement is applied. Always set `rootDir` in production. |
| Personal squad agents | Personal agents operate under Ghost Protocol (read-only project state), but this is enforced by prompt instructions, not code. A misconfigured personal agent could write to project files. |
| Stale env snapshot | The safe environment is captured once when `createWorkstationTools()` is called. Sensitive env vars added after that call are not stripped. |
| `squad upgrade --self` may reach internet | The self-upgrade command constructs a release URL pointing to the upstream repo. In a strict airgap environment, disable `squad upgrade --self`. |

---

## Airgap Notes (This Fork)

This fork is designed to be fully built from source. Key differences from upstream:

| Aspect | Upstream | This Fork |
|--------|----------|-----------|
| Package namespace | `@bradygaster/squad-*` | `@deduvafork/squad-*` |
| LLM SDK | `@github/copilot-sdk` | None — custom Gemini REST client |
| SDK resolution | npm registry | `file:../squad-sdk` (local workspace) |
| Prebuild | — | Wipes `dist/` + `tsconfig.tsbuildinfo` to prevent stale cache |

**To completely airgap:**
- Do not run `squad upgrade --self` (it may check a GitHub releases URL)
- Set `GEMINI_API_KEY` via environment variable or config file — never via npm
- Do not run `npm install` without `--prefer-offline` once initial install is done

---

## Edge Cases

### Running in a git worktree

Squad supports git worktrees. Each worktree can have its own `.squad/` state (worktree-local strategy) or share state from the main checkout (main-checkout strategy). The Coordinator auto-detects which worktree it's in and passes `TEAM_ROOT` to all spawned agents.

### Running without a GitHub account

Most Squad features work without GitHub. These features require `gh auth login`:

- Issue-driven workflow (Ralph, `squad triage --execute`)
- PR creation and merge
- GitHub Actions workflows

Core features — init, agent sessions, decisions, history, export/import — work without GitHub.

### Running on Windows

Squad is tested on Windows. The workstation bash tool uses `cmd.exe` by default. Notes:

- `cmd.exe` has different quoting rules than bash
- Process kill on timeout uses `taskkill /F /T` (process tree kill)
- Path separators in agent output may be `\` instead of `/`

For a more consistent cross-platform shell experience:

```typescript
createWorkstationTools({ shell: 'powershell.exe -Command', rootDir: '...' })
```

### SQUAD_TEAM_ROOT environment variable

Override the `.squad/` root path for monorepo setups:

```bash
SQUAD_TEAM_ROOT=/path/to/shared/squad-state squad init
```

> **Known limitation:** If `SQUAD_TEAM_ROOT` points to a non-existent path, `squad status` and `squad doctor` may behave unexpectedly.

### Multiple humans on a team

Add humans to the squad roster — they appear in routing but are not spawnable. The Coordinator presents work and waits for their input:

```
Add Brady as a PM reviewer.
```

### Externalizing team state

If you work across branches and don't want `.squad/` state to change with each checkout:

```bash
squad externalize
# State moves outside your git working tree
# Persists across branch switches
```

---

## Building from Source (for Contributors)

```bash
git clone https://github.com/DeDuva/squad.git
cd squad
npm install
npm run build

# Type check only (no emit)
npm run lint

# Run tests
npm test
```

**Build internals:** `npm run build` runs `prebuild` first, which:
1. Deletes `packages/squad-sdk/dist/` and `packages/squad-sdk/tsconfig.tsbuildinfo` (prevents stale incremental cache)
2. Cleans any stale nested package copies in `packages/squad-cli/node_modules/`
3. Bumps the build number
4. Syncs skill and project templates

Then compiles SDK, then CLI, in sequence.

---

## Status

Squad is alpha software. The core features work. Known issues:

| Issue | Severity | Status |
|-------|----------|--------|
| `squad doctor` false positive for "squad.js bundle" in user projects | P1 | Fix pending |
| 86 failing tests (model catalog expects Claude/GPT IDs; skill source tests expect `.copilot/` dir) | P1 | Fix pending |
| `squad triage --execute` defaults agent runner to `copilot` CLI | P2 | Documented workaround: `--agent-cmd` flag |
| `squad upgrade --self` may reach bradygaster's GitHub releases URL | P2 | Fix pending; avoid `--self` in strict airgap |
| `npm-package.ts` build metadata has `bradygaster/squad` repo URL | P3 | Fix pending |
| `init.ts` error message URL points to `bradygaster/squad/issues/101` | P3 | Fix pending |
| Casting engine crashes on small universes (usual-suspects + scribe) | P2 | Fix pending |

File issues at: https://github.com/DeDuva/squad/issues
