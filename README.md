# Squad

[English](README.md) | [中文](README.zh.md)

**Human-led AI agent teams for any project.** One command. A team that helps you move faster with your code.

[![Status](https://img.shields.io/badge/status-alpha-blueviolet)](#status)
[![Providers](https://img.shields.io/badge/providers-Copilot%20%7C%20Anthropic%20%7C%20Gemini-blue)](#provider-support)

> ⚠️ **Alpha Software** — Squad is experimental. APIs and CLI commands may change between releases. We'll document breaking changes in [CHANGELOG.md](CHANGELOG.md).

---

> **Fork attribution** — This is a fork of [bradygaster/squad](https://github.com/bradygaster/squad), original work by [Brady Gaster](https://github.com/bradygaster) and contributors. This fork adds multi-provider LLM support (Anthropic, Gemini, and Copilot) and switches to a source-only distribution model.

---

## What's Different in This Fork

| Feature | Original | This Fork |
|---------|----------|-----------|
| LLM backend | GitHub Copilot only | **Copilot, Anthropic Claude, or Google Gemini** |
| Distribution | `npm install -g @bradygaster/squad-cli` | **Run from source** (git clone + build) |
| Provider config | Hardcoded | **`.squad/provider.json`** — set during `squad init` |

The user-facing interface is unchanged: agent names, charters, `.squad/` files, GitHub issue labels, CLI commands, and `.github/agents/squad.agent.md` all behave identically regardless of provider.

---

## Provider Support

| Provider | Models | Requirement |
|----------|--------|-------------|
| **GitHub Copilot** (default) | Your Copilot subscription model | Copilot subscription + `gh copilot` CLI |
| **Anthropic Claude** | `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-haiku-4-5` | `ANTHROPIC_API_KEY` env var |
| **Google Gemini** | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash` | `GEMINI_API_KEY` env var |

Provider is selected interactively during `squad init` and stored in `.squad/provider.json` (gitignored by default).

---

## What is Squad?

Squad gives you a human-directed AI development team. Describe what you're building. Get a team of specialists — frontend, backend, tester, lead — that live in your repo as files. They persist across sessions, learn your codebase, share decisions, and help you move faster without giving up oversight.

Squad is a productivity tool for humans, not a replacement for engineers, reviewers, or decision-makers. People stay accountable for priorities, approvals, and final changes; Squad helps with coordination, repetition, and parallel execution.

It's not a chatbot wearing hats. Each team member runs in its own context, reads only its own knowledge, and writes back what it learned so the work stays inspectable.

> **Responsible AI stance** — Squad is built to amplify a human operator, not to remove humans from the loop. Use it to delegate faster, review better, and keep governance close to the code.

---

## Setup (from source)

Squad is always run from a local build. There is no published npm package to install.

```bash
# 1. Clone the repo
git clone https://github.com/DeDuva/squad
cd squad

# 2. Install dependencies and build both packages
npm install
npm run build

# 3. Make the `squad` command available in your shell
#    Add to your ~/.bashrc or ~/.zshrc for persistence:
alias squad="node $(pwd)/packages/squad-cli/dist/cli-entry.js"

# 4. Verify
squad --version
```

### Staying up to date

```bash
cd squad
git pull
npm run build
```

---

## Quick Start

### 1. Create your project

```bash
mkdir my-project && cd my-project
git init
```

**✓ Validate:** Run `git status` — you should see "No commits yet".

### 2. Initialize Squad

```bash
squad init
```

`squad init` will:
1. Scaffold the `.squad/` directory and agent charters
2. Ask which LLM provider you want to use (Copilot, Anthropic, or Gemini)
3. Write `.squad/provider.json` with your choice

**✓ Validate:** Check that `.squad/team.md` was created in your project.

### 3. Configure your provider

**Copilot (default):** Requires the [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli/about-github-copilot-in-the-cli).

```bash
gh auth login
```

**Anthropic Claude:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**Google Gemini:**

```bash
export GEMINI_API_KEY=AI...
```

### 4. Start your team

**With Copilot:**

```bash
copilot --agent squad --yolo
```

> **Why `--yolo`?** Squad makes many tool calls in a typical session. Without it, Copilot will prompt you to approve each one.

**In VS Code**, open Copilot Chat and select the **Squad** agent.

**With Anthropic or Gemini:**

```bash
squad
```

Then:

```
I'm starting a new project. Set up the team.
Here's what I'm building: a recipe sharing app with React and Node.
```

**✓ Validate:** Squad responds with team member proposals. Type `yes` to confirm — they're ready to work.

---

## Provider Configuration

Provider selection is stored in `.squad/provider.json` (gitignored by default). You can set it during `squad init` or edit it manually:

**Anthropic Claude:**
```json
{
  "type": "anthropic",
  "anthropic": {
    "defaultModel": "claude-sonnet-4-5"
  }
}
```

**Google Gemini:**
```json
{
  "type": "gemini",
  "gemini": {
    "defaultModel": "gemini-2.5-flash"
  }
}
```

**GitHub Copilot (default):**
```json
{
  "type": "copilot"
}
```

API keys are read from environment variables (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`). You can also set them directly in `provider.json`:
```json
{
  "type": "anthropic",
  "anthropic": {
    "apiKey": "sk-ant-...",
    "defaultModel": "claude-sonnet-4-5"
  }
}
```

---

## Upgrading

```bash
cd path/to/squad
git pull
npm run build
```

**Update Squad-owned files in your project** (agent prompts, workflows, templates):

```bash
squad upgrade
```

`squad upgrade` updates `squad.agent.md`, templates, and GitHub workflows to the latest versions. It never touches your `.squad/` team state — your agents, decisions, and history are always preserved.

---

## All Commands (17 commands)

| Command | What it does |
|---------|-------------|
| `squad init` | **Init** — scaffold Squad in the current directory (idempotent — safe to run multiple times); alias: `hire`; use `--global` to init in personal squad directory, `--mode remote <path>` for dual-root mode |
| `squad upgrade` | Update Squad-owned files to latest; never touches your team state; use `--global` to upgrade personal squad, `--migrate-directory` to rename `.ai-team/` → `.squad/` |
| `squad upgrade --self` | Pull the latest Squad source and rebuild |
| `squad status` | Show which squad is active and why |
| `squad triage` | **Watch mode** — poll for issues and auto-triage to team (aliases: `watch`, `loop`); use `--interval <minutes>` to set polling frequency (default: 10); with `--execute` dispatch agents; use `--agent-cmd`, `--copilot-flags`, `--auth-user` to customize agent execution; `--health` shows watch status; `--log-file` for diagnostics |
| `squad copilot` | Add/remove the Copilot coding agent (@copilot); use `--off` to remove, `--auto-assign` to enable auto-assignment |
| `squad doctor` | Check your setup and diagnose issues (alias: `heartbeat`) |
| `squad link <team-repo-path>` | Connect to a remote team |
| `squad externalize` | Move `.squad/` state outside the working tree; survives branch switches; use `--key <name>` for custom project key |
| `squad internalize` | Move externalized state back into `.squad/` |
| `squad shell` | **Deprecated** — Launch interactive shell explicitly. Use `copilot --agent squad` or the `squad` REPL instead. |
| `squad export` | Export squad to a portable JSON snapshot |
| `squad import <file>` | Import squad from an export file |
| `squad plugin marketplace add\|remove\|list\|browse` | Manage plugin marketplaces |
| `squad upstream add\|remove\|list\|sync` | Manage upstream Squad sources |
| `squad nap` | Context hygiene — compress, prune, archive; use `--deep` for aggressive compression, `--dry-run` to preview changes |
| `squad aspire` | Open Aspire dashboard for observability |
| `squad scrub-emails [directory]` | Remove email addresses from Squad state files (default: `.squad/`) |

---

## Watch Mode — Ralph's Automated Polling

Ralph continuously polls for work and dispatches agents to handle it. Watch mode helps a human team stay responsive — Ralph automates triage, execution handoffs, and monitoring, then escalates back to people when judgment or approval is needed.

### Quick Start

```bash
# Monitor for issues (triage mode — no execution)
squad watch

# Monitor and auto-execute against actionable issues
squad watch --execute --interval 5

# With custom agent runner and copilot flags
squad watch --execute \
  --agent-cmd "gh copilot" \
  --copilot-flags "--yolo --autopilot --mcp mail --agent squad" \
  --auth-user myaccount

# Run watch with diagnostics
squad watch --execute --log-file ./watch.log --verbose

# Check health of running watch process
squad watch --health
```

### Key Flags

| Flag | Description |
|------|-------------|
| `--execute` | Enable agent execution (spawn agent sessions for actionable issues) |
| `--interval N` | Poll every N minutes (default: 10) |
| `--agent-cmd` | Custom agent command (default: `gh copilot`) |
| `--copilot-flags` | Flags passed to the agent runner (e.g., `--yolo --autopilot`) |
| `--auth-user` | GitHub/Azure DevOps account to use for agent auth |
| `--log-file` | Mirror output to file for later review and diagnostics |
| `--verbose` | Show extra diagnostic output (auth probes, callbacks, pulls) |
| `--health` | Show status of running watch: PID, uptime, auth readiness, capabilities |
| `--overnight-start HH:MM` | Pause watch during off-hours (e.g., `--overnight-start 18:00`) |
| `--overnight-end HH:MM` | Resume watch at this time (e.g., `--overnight-end 08:00`) |
| `--notify-level` | Control output verbosity (`all` / `important` / `none`, default: `important`) |
| `--state-backend` | Persistence strategy (`git-notes` or `orphan-branch`, default: in-memory) |

### How Watch Decides What to Execute

Ralph uses an **agent-delegated selection pattern**:

1. Ralph scans for triage-eligible issues (unassigned, labeled, etc.)
2. Ralph builds a context snapshot: issue list, squad state, recent decisions
3. Ralph writes this context to a **temp file** using the `-p <path>` flag
4. Ralph invokes the agent with that file: `gh copilot -p context.md`
5. The agent **decides which issue to work on** and **how**
6. Ralph monitors execution, logs results, updates issue status

This design keeps the polling loop lean while letting agents handle issue selection automatically under the team's rules, review gates, and escalation policy.

### Issue Selection & Escalation

Ralph provides a rich prompt scaffold to the agent:

```
## Work Context

### Available Issues (prioritized)
- #42 Urgent bug in auth (P0)
- #89 Performance review pending (P1)
- #123 Docs update (P2)

### Why These Issues Matter
...context from decision archive...

### Success Criteria
- Tests pass
- Changes match team conventions
- PR linked to issue

### When to Escalate
If blocker detected → pause, log, notify humans
```

Agents see **full context** and can decide intelligently rather than blindly executing random work.

### Error Recovery (4-Tier Escalation)

Watch includes a tiered remediation strategy:

1. **Tier 1 — Circuit Breaker Reset**: Clear and retry
2. **Tier 2 — Auth Reprobe**: Re-verify credentials
3. **Tier 3 — Git Pull**: Update local state
4. **Tier 4 — Pause 30m**: Back off for human intervention

This prevents watch from spamming the same failure endlessly.

### State Backends

Watch can persist its state in different ways:

```bash
# Default: in-memory (loses state on restart)
squad watch --execute

# Persist to git-notes (survives restarts, no new branches)
squad watch --execute --state-backend git-notes

# Persist to orphan branch (isolated history, easy to prune)
squad watch --execute --state-backend orphan-branch
```

### Graceful Shutdown

To stop a running watch process gracefully:

```bash
# Create sentinel file
touch .squad/ralph-stop

# Watch will finish current round and exit cleanly
# Logs final state, cleans scratch dirs
```

### Cleanup

Watch automatically prunes stale artifacts:
- Scratch directories older than 7 days
- Log files older than 30 days
- Orphaned orchestration state

### Monitoring Watch

Check on a running watch:

```bash
squad watch --health
```

Output example:
```
Ralph Watch Status

PID: 12345
Uptime: 2h 15m
Last Poll: 2 minutes ago

Auth: Ready (account: myaccount@github.com)
Capabilities: Issue triage, PR review, ADO sync

Next Poll: 14:35 (in 3 minutes)
Round: 42 / 1200
```

---

## Interactive Shell

Tired of typing `squad` followed by a command every time? Enter the interactive shell.

### Entering the Shell

```bash
squad
```

No arguments. Just `squad`. You'll get a prompt:

```
squad >
```

You're now connected to your team. Talk to them.

### Shell Commands

All shell commands start with `/`:

| Command | What it does |
|---------|-------------|
| `/status` | Check your team and what's happening |
| `/history` | See recent messages |
| `/agents` | List all team members |
| `/sessions` | List saved sessions |
| `/resume <id>` | Restore a past session |
| `/version` | Show version |
| `/clear` | Clear the screen |
| `/help` | Show all commands |
| `/quit` | Exit the shell (or Ctrl+C) |

### Talking to Agents

Use `@AgentName` (case-insensitive) or natural language with a comma:

```
squad > @Keaton, analyze the architecture of this project
squad > McManus, write a blog post about our new feature
squad > Build the login page
```

The coordinator routes messages to the right agents. Multiple agents can work in parallel—you'll see progress in real-time.

### What the Shell Does

- **Real-time visibility:** See agents working, decisions being recorded, blockers as they happen
- **Message routing:** Describe what you need; the coordinator figures out who should do it
- **Parallel execution:** Multiple agents work simultaneously on independent tasks
- **Session persistence:** If an agent crashes, it resumes from checkpoint; you never lose context
- **Decision logging:** Every decision is recorded in `.squad/decisions.md` for the whole team to see

For more details on shell usage, see the commands table above.

## Samples

Eight working examples from beginner to advanced — casting, governance, streaming, Docker. See [samples/README.md](samples/README.md).

---

## Agents Work in Parallel — You Stay in Control

Squad helps one human coordinate more work at once. When you give a task, the coordinator launches every agent that can usefully start — simultaneously — while you keep priorities, review, and final decisions.

```
You: "Team, build the login page"

  🏗️ Lead — analyzing requirements...          ⎤
  ⚛️ Frontend — building login form...          ⎥ all launched
  🔧 Backend — setting up auth endpoints...     ⎥ in parallel
  🧪 Tester — writing test cases from spec...   ⎥
  📋 Scribe — logging everything...             ⎦
```

When agents finish, the coordinator records follow-up work and leaves a breadcrumb trail so you can review what happened with full context:

- **`decisions.md`** — every decision any agent made
- **`orchestration-log/`** — what was spawned, why, and what happened
- **`log/`** — full session history, searchable

**Knowledge compounds across sessions.** Every time an agent works, it writes lasting learnings to its `history.md`. After a few sessions, agents know your conventions, your preferences, your architecture. They stop asking questions they've already answered.

**And it's all in git.** Anyone who clones your repo gets the team — with all their accumulated knowledge.

---

## What Gets Created

```
.squad/
├── team.md              # Roster — who's on the team
├── routing.md           # Routing — who handles what
├── decisions.md         # Shared brain — team decisions
├── ceremonies.md        # Sprint ceremonies config
├── provider.json        # LLM provider config (gitignored)
├── casting/
│   ├── policy.json      # Casting configuration
│   ├── registry.json    # Persistent name registry
│   └── history.json     # Universe usage history
├── agents/
│   ├── {name}/
│   │   ├── charter.md   # Identity, expertise, voice
│   │   └── history.md   # What they know about YOUR project
│   └── scribe/
│       └── charter.md   # Silent memory manager
├── skills/              # Compressed learnings from work
├── identity/
│   ├── now.md           # Current team focus
│   └── wisdom.md        # Reusable patterns
└── log/                 # Session history (searchable archive)
```

**Commit this folder** (except `provider.json`, which is gitignored). Your team persists. Names persist. Anyone who clones gets the team — with the same cast.

### SDK-First Mode (Experimental)

> ⚠️ **Experimental.** SDK-first mode is under active development and has known bugs. Use markdown-first (the default) for production teams.

Prefer TypeScript? You can define your team in code instead of markdown. Create a `squad.config.ts` with builder functions, run `squad build`, and the `.squad/` files are generated automatically.

```typescript
// squad.config.ts
import { defineSquad, defineTeam, defineAgent } from '@squad/sdk';

export default defineSquad({
  team: defineTeam({ name: 'Platform Squad', members: ['@edie', '@mcmanus'] }),
  agents: [
    defineAgent({ name: 'edie', role: 'TypeScript Engineer', model: 'claude-sonnet-4' }),
    defineAgent({ name: 'mcmanus', role: 'DevRel', model: 'claude-haiku-4.5' }),
  ],
});
```

Run `squad build` to generate all the markdown. See the [SDK-First Mode Guide](docs/src/content/docs/sdk-first-mode.md) for full documentation.

---

## Development

Squad is a monorepo with two packages:
- **`@squad/sdk`** — Core runtime and library for programmable agent orchestration
- **`@squad/cli`** — Command-line interface that depends on the SDK

### Building

```bash
# Install dependencies (npm workspaces)
npm install

# Build TypeScript to dist/
npm run build

# Build CLI bundle (dist/ + esbuild → cli.js)
npm run build:cli

# Watch mode for development
npm run dev
```

### Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch
```

### Linting

```bash
# Type check (no emit)
npm run lint
```

---

## SDK documentation

The SDK provides programmatic control over agent orchestration — custom tools, hook pipelines, file-write guards, PII scrubbing, reviewer lockout, and event-driven monitoring.

- [SDK API reference](docs/src/content/docs/reference/sdk.md)
- [Custom tools and hooks guide](docs/src/content/docs/reference/tools-and-hooks.md)
- [Extensibility guide](docs/src/content/docs/guide/extensibility.md)
- [Samples](samples/README.md) — eight working examples from beginner to advanced

To use the SDK from source in another project:

```typescript
import { SquadClient } from '@squad/sdk/client';

const client = new SquadClient({
  provider: 'anthropic',
  anthropic: { model: 'claude-sonnet-4-5' },
});
await client.connect();
```
