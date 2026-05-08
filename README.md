# Squad

[English](README.md) | [中文](README.zh.md)

**Human-led AI agent teams for any project.** One command. A team that helps you move faster with your code.

[![Status](https://img.shields.io/badge/status-alpha-blueviolet)](#status)
[![Platform](https://img.shields.io/badge/platform-Gemini-blue)](#what-is-squad)
[![Build](https://img.shields.io/badge/build-from--source-green)](#building)

> ⚠️ **Alpha Software** — Squad is experimental. APIs and CLI commands may change between releases. We'll document breaking changes in [CHANGELOG.md](CHANGELOG.md).

> **Fork note:** This is the `@deduvafork/squad` Gemini replatform. It replaces GitHub Copilot with the Gemini API and runs in airgap mode — all code is built from source; no binaries are downloaded from the original upstream author.

---

## What is Squad?

Squad gives you a human-directed AI development team. Describe what you're building. Get a team of specialists — frontend, backend, tester, lead — that live in your repo as files. They persist across sessions, learn your codebase, share decisions, and help you move faster without giving up oversight.

Squad is a productivity tool for humans, not a replacement for engineers, reviewers, or decision-makers. People stay accountable for priorities, approvals, and final changes; Squad helps with coordination, repetition, and parallel execution.

It's not a chatbot wearing hats. Each team member runs in its own context, reads only its own knowledge, and writes back what it learned so the work stays inspectable.

> **Responsible AI stance** — Squad is built to amplify a human operator, not to remove humans from the loop. Use it to delegate faster, review better, and keep governance close to the code.

---

## Quick Start

### Prerequisites

- Node.js ≥ 22.5.0
- A [Gemini API key](https://aistudio.google.com/app/apikey) — set as `GEMINI_API_KEY` in your environment

### 1. Create your project

```bash
mkdir my-project && cd my-project
git init
```

**✓ Validate:** Run `git status` — you should see "No commits yet".

### 2. Build and install Squad from source

```bash
git clone https://github.com/DeDuva/squad.git
cd squad
npm install
npm run build
npm link -w packages/squad-cli
```

**✓ Validate:** Run `squad --version` — you should see the current version.

### 3. Set your Gemini API key

```bash
export GEMINI_API_KEY=your-api-key-here
```

### 4. Initialize and run

```bash
cd /path/to/my-project
squad init
squad
```

Then:

```
I'm starting a new project. Set up the team.
Here's what I'm building: a recipe sharing app with React and Node.
```

**✓ Validate:** Squad responds with team member proposals. Type `yes` to confirm — they're ready to work.

Squad proposes a team — each member named from a persistent thematic cast. You say **yes**. They're ready.

---

## Upgrading

Since this fork runs in airgap mode, upgrade by pulling the latest source and rebuilding:

```bash
cd /path/to/squad
git pull
npm install
npm run build
```

`squad upgrade` updates `squad.agent.md`, templates, and GitHub workflows to the latest versions. It never touches your `.squad/` team state — your agents, decisions, and history are always preserved.

---

## All Commands (17 commands)

| Command | What it does |
|---------|-------------|
| `squad init` | **Init** — scaffold Squad in the current directory (idempotent — safe to run multiple times); alias: `hire`; use `--global` to init in personal squad directory, `--mode remote <path>` for dual-root mode |
| `squad upgrade` | Update Squad-owned files to latest; never touches your team state; use `--global` to upgrade personal squad, `--migrate-directory` to rename `.ai-team/` → `.squad/` |
| `squad status` | Show which squad is active and why |
| `squad triage` | **Watch mode** — poll for issues and auto-triage to team (aliases: `watch`, `loop`); use `--interval <minutes>` to set polling frequency (default: 10); with `--execute --agent-cmd <cmd>` dispatch agent sessions; use `--auth-user` to customize auth; `--health` shows watch status; `--log-file` for diagnostics |
| `squad doctor` | Check your setup and diagnose issues (alias: `heartbeat`) |
| `squad link <team-repo-path>` | Connect to a remote team |
| `squad externalize` | Move `.squad/` state outside the working tree; survives branch switches; use `--key <name>` for custom project key |
| `squad internalize` | Move externalized state back into `.squad/` |
| `squad shell` | **Deprecated** — Launch interactive shell explicitly. |
| `squad export` | Export squad to a portable JSON snapshot |
| `squad import <file>` | Import squad from an export file |
| `squad plugin marketplace add\|remove\|list\|browse` | Manage plugin marketplaces |
| `squad upstream add\|remove\|list\|sync` | Manage upstream Squad sources |
| `squad nap` | Context hygiene — compress, prune, archive; use `--deep` for aggressive compression, `--dry-run` to preview changes |
| `squad aspire` | Open Aspire dashboard for observability |
| `squad scrub-emails [directory]` | Remove email addresses from Squad state files (default: `.squad/`) |
| `squad start --command <cmd>` | PTY mirror mode — spawn an agent in a PTY and mirror output to phone/browser via WebSocket + devtunnel |

---

## Watch Mode — Ralph's Automated Polling

Ralph continuously polls for work and dispatches agents to handle it. Watch mode helps a human team stay responsive — Ralph automates triage, execution handoffs, and monitoring, then escalates back to people when judgment or approval is needed.

### Quick Start

```bash
# Monitor for issues (triage mode — no execution)
npx @deduvafork/squad-cli watch

# Monitor and auto-execute against actionable issues (requires --agent-cmd)
npx @deduvafork/squad-cli watch --execute --agent-cmd "gemini-cli" --interval 5

# Run watch with diagnostics
npx @deduvafork/squad-cli watch --execute --agent-cmd "gemini-cli" --log-file ./watch.log --verbose

# Check health of running watch process
npx @deduvafork/squad-cli watch --health
```

### Key Flags

| Flag | Description |
|------|-------------|
| `--execute` | Enable agent execution (spawn agent sessions for actionable issues) |
| `--interval N` | Poll every N minutes (default: 10) |
| `--agent-cmd` | Agent command to run for each issue (required with `--execute`) |
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
4. Ralph invokes the agent with that file: `<agent-cmd> -p context.md`
5. The agent **decides which issue to work on** and **how**
6. Ralph monitors execution, logs results, updates issue status

This design keeps the polling loop lean while letting agents handle issue selection automatically under the team's rules, review gates, and escalation policy.

### Error Recovery (4-Tier Escalation)

Watch includes a tiered remediation strategy:

1. **Tier 1 — Circuit Breaker Reset**: Clear and retry
2. **Tier 2 — Auth Reprobe**: Re-verify credentials
3. **Tier 3 — Git Pull**: Update local state
4. **Tier 4 — Pause 30m**: Back off for human intervention

### State Backends

Watch can persist its state in different ways:

```bash
# Default: in-memory (loses state on restart)
squad watch --execute --agent-cmd "gemini-cli"

# Persist to git-notes (survives restarts, no new branches)
squad watch --execute --agent-cmd "gemini-cli" --state-backend git-notes

# Persist to orphan branch (isolated history, easy to prune)
squad watch --execute --agent-cmd "gemini-cli" --state-backend orphan-branch
```

---

## Interactive Shell

> ⚠️ **Deprecated:** The interactive shell (`squad` with no arguments) has been deprecated. Use your configured agent runner directly instead.

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

---

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

**Commit this folder.** Your team persists. Names persist. Anyone who clones gets the team — with the same cast.

### SDK-First Mode

> ⚠️ **Experimental.** SDK-first mode is under active development and has known bugs. Use markdown-first (the default) for production teams.

Prefer TypeScript? You can define your team in code instead of markdown. Create a `squad.config.ts` with builder functions, run `squad build`, and the `.squad/` files are generated automatically.

```typescript
// squad.config.ts
import { defineSquad, defineTeam, defineAgent } from '@deduvafork/squad-sdk';

export default defineSquad({
  team: defineTeam({ name: 'Platform Squad', members: ['@edie', '@mcmanus'] }),
  agents: [
    defineAgent({ name: 'edie', role: 'TypeScript Engineer', model: 'gemini-2.5-pro-preview-05-06' }),
    defineAgent({ name: 'mcmanus', role: 'DevRel', model: 'gemini-2.5-flash' }),
  ],
});
```

Run `squad build` to generate all the markdown. See the [SDK-First Mode Guide](docs/src/content/docs/sdk-first-mode.md) for full documentation.

---

## Monorepo Development

Squad is a monorepo with two packages:
- **`@deduvafork/squad-sdk`** — Core runtime and library for programmable agent orchestration
- **`@deduvafork/squad-cli`** — Command-line interface that depends on the SDK

### Building

```bash
# Install dependencies (npm workspaces)
npm install

# Build TypeScript to dist/
npm run build
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

### Environment

Set `GEMINI_API_KEY` before running or testing anything that invokes the Gemini client:

```bash
export GEMINI_API_KEY=your-api-key-here
```

---

## SDK documentation

The SDK provides programmatic control over agent orchestration — custom tools, hook pipelines, file-write guards, PII scrubbing, reviewer lockout, and event-driven monitoring.

- [SDK API reference](docs/src/content/docs/reference/sdk.md)
- [Custom tools and hooks guide](docs/src/content/docs/reference/tools-and-hooks.md)
- [Extensibility guide](docs/src/content/docs/guide/extensibility.md)
- [Samples](samples/README.md) — eight working examples from beginner to advanced

For SDK installation (from source): `npm install @deduvafork/squad-sdk`
