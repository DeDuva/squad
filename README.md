# Squad

**Human-led AI agent teams for any project.** Describe what you're building. Get a team of named specialists that lives in your repo, persists across sessions, and learns your codebase.

[![Status](https://img.shields.io/badge/status-alpha-blueviolet)](#status)
[![Providers](https://img.shields.io/badge/providers-Copilot%20%7C%20Anthropic%20%7C%20Gemini-blue)](#provider-support)

> ⚠️ **Alpha Software** — Squad is experimental. APIs and CLI commands may change between releases. We'll document breaking changes in [CHANGELOG.md](CHANGELOG.md).

---

## What is Squad?

Squad gives you a human-directed AI development team. You describe your project; Squad casts a team of named specialists — frontend, backend, tester, lead — that live in your repo as files. They persist across sessions, learn your codebase, share decisions, and help you move faster without giving up oversight.

When you give a task, the coordinator launches every relevant agent simultaneously:

```
You: "Team, build the login page"

  🏗️ Lead — analyzing requirements...          ⎤
  ⚛️ Frontend — building login form...          ⎥ all launched
  🔧 Backend — setting up auth endpoints...     ⎥ in parallel
  🧪 Tester — writing test cases from spec...   ⎥
  📋 Scribe — logging everything...             ⎦
```

Squad is a productivity tool for humans, not a replacement for engineers, reviewers, or decision-makers. You stay accountable for priorities, approvals, and final changes. Every decision any agent makes is recorded in `.squad/decisions.md` so you can review what happened with full context.

> **Responsible AI stance** — Squad is built to amplify a human operator, not to remove humans from the loop. Use it to delegate faster, review better, and keep governance close to the code.

---

## Provider Support

Squad works with the LLM provider you already have access to:

| Provider | Models | Requirement |
|----------|--------|-------------|
| **Anthropic Claude** | `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5` | `ANTHROPIC_API_KEY` env var |
| **Google Gemini** | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash` | `GEMINI_API_KEY` env var |
| **GitHub Copilot** | Your Copilot subscription model | Copilot subscription + `gh copilot` CLI |

Provider is selected interactively during `squad init` and stored in `.squad/provider.json` (gitignored).

> **Fork attribution** — This is a fork of [bradygaster/squad](https://github.com/bradygaster/squad), original work by [Brady Gaster](https://github.com/bradygaster) and contributors. This fork adds multi-provider LLM support and switches to source-only distribution.

---

## Prerequisites

- **Node.js 18+** and **npm 8+**
- **git**
- One of:
  - Anthropic: `ANTHROPIC_API_KEY` environment variable
  - Gemini: `GEMINI_API_KEY` environment variable
  - Copilot: `gh auth login` + an active GitHub Copilot subscription

---

## Setup (from source)

Squad runs from a local build. There is no published npm package — you clone the repo, build it once, then create a shell alias so `squad` is available in any project.

```bash
# 1. Clone and build
git clone https://github.com/DeDuva/squad
cd squad
npm install
npm run build

# 2. Verify
node packages/squad-cli/dist/cli-entry.js --version
```

### Make `squad` available everywhere

Add this line to your `~/.bashrc` or `~/.zshrc`, replacing the path with wherever you cloned Squad:

```bash
alias squad="node /path/to/squad/packages/squad-cli/dist/cli-entry.js"
```

Then reload your shell:

```bash
source ~/.bashrc   # or source ~/.zshrc
squad --version
```

> **Important:** Without adding the alias to your shell config file, `squad` stops working when you open a new terminal. This is the step most often missed on a first install.

---

## How Squad and Your Projects Relate

Squad is installed once. You use it across as many projects as you like.

```
~/dev/squad/          ← Squad source (install once, alias globally)
~/dev/my-app/         ← Your project  (run `squad init` here)
~/dev/another-app/    ← Another project (run `squad init` here too)
```

When you run `squad init` in a project, a `.squad/` folder is created in that project's repo. Your team's charters, decisions, and accumulated knowledge live there. The Squad source itself never appears in your project.

Your project repo contains your work and your team's working memory — not the Squad tool.

---

## Quick Start

### 1. Create your project

```bash
mkdir my-project && cd my-project
git init
```

### 2. Initialize Squad

```bash
squad init
```

`squad init` will:
1. Scaffold the `.squad/` directory and initial agent files
2. Ask which LLM provider you want to use
3. Write `.squad/provider.json` with your choice

**✓ Validate:** Check that `.squad/team.md` was created in your project.

### 3. Configure your provider

You can provide your API key during `squad init` (it gets saved to `.squad/provider.json`, which is gitignored) or set it as an environment variable. Either is safe.

**Anthropic Claude:**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**Google Gemini:**
```bash
export GEMINI_API_KEY=AI...
```

**GitHub Copilot:**
```bash
gh auth login
```

### 4. Start your team

```bash
squad
```

You'll get a prompt:

```
squad >
```

Describe your project:

```
I'm starting a new project. Set up the team.
Here's what I'm building: a recipe sharing app with React and Node.
```

The coordinator will propose a team — named agents with specific roles and personalities. Type `yes` to confirm and they're ready to work.

> **What are agent names?** Squad gives agents distinctive names (like "Flight" for a lead engineer or "Pixel" for a frontend specialist) rather than generic labels. This makes conversations natural and lets each agent build a distinct voice and expertise. Their identities are stored in `.squad/agents/{name}/charter.md` and version-controlled with your project.

---

## Working With Your Team

### Talking to agents

Use `@AgentName` to direct work to a specific agent, or describe what you need and the coordinator routes it:

```
squad > @Flight, review the authentication architecture
squad > @Pixel @Core, build the login flow — Pixel does the form, Core does the API
squad > Write tests for everything we built today
```

Multiple agents can work in parallel — you'll see progress streaming in real-time.

### Shell commands

| Command | What it does |
|---------|-------------|
| `/status` | Check your team and what's happening |
| `/agents` | List all team members |
| `/history [N]` | See recent messages (default 10) |
| `/sessions` | List saved sessions |
| `/resume <id>` | Restore a past session |
| `/nap` | Context hygiene — compress, prune, archive |
| `/help` | Show all commands |
| `/quit` | Exit (or Ctrl+C) |

### Knowledge compounds across sessions

Every time an agent works, it writes lasting learnings to `.squad/agents/{name}/history.md`. After a few sessions, agents know your conventions, your architecture, your preferences — they stop asking questions they've already answered. This history is version-controlled: anyone who clones your repo gets the team with all accumulated context.

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
└── log/                 # Session history (gitignored)
```

**Commit `.squad/`** (except `provider.json`, which is gitignored). Your team, their identities, and accumulated knowledge persist across sessions and across team members.

---

## Provider Configuration

Provider selection is stored in `.squad/provider.json`. Set it during `squad init` or edit manually:

**Anthropic Claude:**
```json
{
  "type": "anthropic",
  "anthropic": {
    "defaultModel": "claude-sonnet-4-6"
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

**GitHub Copilot:**
```json
{
  "type": "copilot"
}
```

API keys are read from environment variables (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`). You can also inline them in `provider.json`, though environment variables are recommended to avoid committing credentials:

```json
{
  "type": "anthropic",
  "anthropic": {
    "apiKey": "sk-ant-...",
    "defaultModel": "claude-sonnet-4-6"
  }
}
```

---

## Watch Mode — Automated Issue Dispatch

Watch mode lets Ralph (a background monitor) poll your issue tracker and automatically dispatch agents to handle incoming work.

```bash
# Monitor issues (triage mode — no execution)
squad watch

# Monitor and auto-execute against actionable issues
squad watch --execute --interval 5

# Run with diagnostics
squad watch --execute --log-file ./watch.log --verbose

# Check health of running watch
squad watch --health
```

When an issue is labeled `squad:{member}` (e.g., `squad:flight`), Ralph spawns that agent, who creates a branch, implements, and opens a PR.

> **Provider note:** Watch mode's `--execute` flag currently defaults to dispatching agents via the `gh copilot` CLI. If you're using Anthropic or Gemini, specify your runner with `--agent-cmd`. For most cases with non-Copilot providers, the interactive shell is the more straightforward path for agent dispatch.

### Key flags

| Flag | Description |
|------|-------------|
| `--execute` | Enable agent execution |
| `--interval N` | Poll every N minutes (default: 10) |
| `--agent-cmd` | Custom agent runner command |
| `--log-file` | Mirror output to file for diagnostics |
| `--verbose` | Show extra diagnostic output |
| `--health` | Show status of running watch process |
| `--state-backend` | Persistence: `git-notes` or `orphan-branch` |
| `--overnight-start HH:MM` | Pause watch during off-hours |
| `--overnight-end HH:MM` | Resume watch at this time |

### How watch decides what to execute

Ralph scans for triage-eligible issues, builds a context snapshot (issue list, squad state, recent decisions), and passes it to the agent. The agent decides which issue to work on and how, under the team's routing rules and review gates.

### Error recovery

Watch uses a 4-tier escalation so it never spins on the same failure:

1. **Circuit Breaker Reset** — clear and retry
2. **Auth Reprobe** — re-verify credentials
3. **Git Pull** — update local state
4. **Pause 30m** — back off for human intervention

### Stopping watch

```bash
touch .squad/ralph-stop
# Watch finishes its current round and exits cleanly
```

---

## Upgrading

```bash
# Update Squad source
squad upgrade --self
# or manually: cd path/to/squad && git pull && npm run build

# Update Squad-owned files in your project (agent prompts, workflows, templates)
squad upgrade
```

`squad upgrade` updates `squad.agent.md`, templates, and GitHub workflows. It never touches your team state — agents, decisions, and history are always preserved.

---

## All Commands

| Command | What it does |
|---------|-------------|
| `squad init` | Scaffold Squad in the current directory (idempotent); alias: `hire`; `--global` for personal squad; `--mode remote <path>` for dual-root |
| `squad` | Launch the interactive shell |
| `squad upgrade` | Update Squad-owned project files; `--self` upgrades Squad source |
| `squad status` | Show which squad is active and why |
| `squad triage` | Watch mode — poll for issues and auto-triage (aliases: `watch`, `loop`); `--execute` to dispatch agents; `--health` to check status |
| `squad doctor` | Check your setup and diagnose issues (alias: `heartbeat`) |
| `squad link <path>` | Connect to a remote team |
| `squad externalize` | Move `.squad/` state outside the working tree (survives branch switches) |
| `squad internalize` | Move externalized state back into `.squad/` |
| `squad export` | Export squad to a portable JSON snapshot |
| `squad import <file>` | Import squad from an export file |
| `squad copilot` | Add/remove the Copilot coding agent (@copilot) |
| `squad plugin marketplace add\|remove\|list\|browse` | Manage plugin marketplaces |
| `squad upstream add\|remove\|list\|sync` | Manage upstream Squad sources |
| `squad nap` | Context hygiene — compress, prune, archive |
| `squad aspire` | Open Aspire observability dashboard |
| `squad scrub-emails [dir]` | Remove email addresses from Squad state files |

---

## Development

Squad is a monorepo with two packages:
- **`@squad/sdk`** — Core runtime and library for programmable agent orchestration
- **`@squad/cli`** — Command-line interface that depends on the SDK

```bash
npm install          # workspace install
npm run build        # compile TypeScript → dist/
npm run build:cli    # build CLI bundle (esbuild → cli.js)
npm run dev          # watch mode
npm test             # run all tests
npm run test:watch   # test watch mode
npm run lint         # type check (no emit)
```
