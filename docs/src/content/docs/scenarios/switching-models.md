# Switching AI Models — Budget vs Quality

**Try this to reduce costs temporarily:**
```
Switch everyone to Haiku — I'm trying to save costs this sprint
```

**Try this to maximize quality:**
```
Use Opus for all agents — quality over cost for this session
```

**Try this to restore defaults:**
```
Reset to default model strategy
```

Squad routes each agent to a model tier — premium, standard, or fast — within the vendor you are running on. Switch the entire team, set per-agent preferences, or let Squad auto-route based on task type.

---

## 1. The Default: Cost-First Strategy

Model selection strategies for different needs, with per-tier fallback chains.

Squad's default model configuration prioritizes cost-effectiveness:

- **Non-code tasks** (planning, triage, decisions) → `claude-haiku-4-5` (fast, cheap)
- **Code tasks** (implementation, refactoring) → `claude-sonnet-5` (balanced quality/cost)
- **Code review** (critical analysis) → `claude-sonnet-5`

This is optimized for **everyday use** — good quality without burning your API budget.

---

## 2. Budget Mode: Always Use Haiku

If you're cost-sensitive or working on a small project:

```
> Switch the entire team to claude-haiku-4-5 for all tasks.
```

```
✅ Model configuration updated

All agents now use claude-haiku-4-5 (fast/cheap tier)

Agents will be faster but may need more guidance on complex tasks.
```

This is written to `.ai-team/model-config.json`:

```json
{
  "default": "claude-haiku-4-5",
  "overrides": {}
}
```

Now every agent uses Haiku for everything. Faster responses, lower cost, slightly less nuanced reasoning.

---

## 3. Quality Mode: Use Opus for Critical Work

If you're working on architecture, security, or high-stakes features:

```
> Use claude-opus-5 for Neo (the Lead) and claude-sonnet-5
> for everyone else.
```

```
✅ Model configuration updated

Neo (Lead) → claude-opus-5 (premium tier)
All other agents → claude-sonnet-5 (standard tier)

Neo will give higher-quality code reviews and architectural guidance.
```

This is written to `.ai-team/model-config.json`:

```json
{
  "default": "claude-sonnet-5",
  "overrides": {
    "neo": "claude-opus-5"
  }
}
```

Neo gets the premium model for code reviews and decisions. Everyone else stays on Sonnet.

---

## 4. Per-Agent Overrides

You can set different models for different roles:

```
> Configure models like this:
> Neo (Lead) → opus (best quality for code review)
> Trinity (Frontend) → sonnet (balanced)
> Morpheus (Backend) → sonnet (balanced)
> Tank (Tester) → haiku (tests don't need premium reasoning)
```

```
✅ Model configuration updated

Neo → claude-opus-5 (premium)
Trinity → claude-sonnet-5 (standard)
Morpheus → claude-sonnet-5 (standard)
Tank → claude-haiku-4-5 (fast/cheap)
```

Tank doesn't need Opus to write tests. Neo does need it for code reviews. Balanced spend.

---

## 5. The 16-Model Catalog

Squad talks to one vendor at a time. Each covers three tiers, and every id is
an alias that tracks the vendor's latest release — never a pinned version, which
would keep working after the vendor ships its successor.

**Anthropic** (default):
- `claude-opus-5` — premium; deepest reasoning, vision
- `claude-sonnet-5` — standard; the default for code tasks
- `claude-haiku-4-5` — fast; the default for non-code tasks

**Google Gemini** (`squad config provider gemini`):
- `gemini-pro-latest` — premium
- `gemini-flash-latest` — standard and fast

**Note:** A vendor is usable only when its API key is present — `ANTHROPIC_API_KEY` (or a signed-in `claude` CLI) for Anthropic, `GEMINI_API_KEY` for Gemini.

---

## 6. Fallback Chains

If a model is unavailable, Squad falls back to the next tier:

```
claude-opus-5 → claude-sonnet-5 → claude-haiku-4-5
```

If Opus is unavailable (rate limit, quota), Squad automatically uses Sonnet. If Sonnet is unavailable, it falls back to Haiku.

You don't have to configure this — it's automatic.

---

## 7. When to Use Which Model

**Use Haiku (`claude-haiku-4-5`) when:**
- Writing tests
- Running triage or planning tasks
- Generating boilerplate code
- Refactoring (simple renames, restructuring)
- You're on a budget and speed matters more than depth

**Use Sonnet (`claude-sonnet-5`) when:**
- Writing feature code
- Implementing APIs or UI components
- Refactoring with logic changes
- Most everyday development tasks

**Use Opus (`claude-opus-5`) when:**
- Code review (the Lead should catch subtle bugs)
- Architectural decisions
- Security-sensitive code
- Complex debugging
- Critical features where quality trumps cost

---

## 8. Sample Prompts for Model Configuration

**Check current model configuration:**

```
> What models is the team using?
```

**Switch everyone to budget mode:**

```
> Switch all agents to haiku. We're prototyping, speed matters
> more than perfection.
```

**Use premium for the Lead only:**

```
> Neo should use opus for code reviews. Everyone else stays on sonnet.
```

**Temporary override for a specific task:**

```
> Morpheus, use opus for this security-critical auth implementation.
```

**Reset to defaults:**

```
> Reset model configuration to Squad's defaults.
```

---

## Tips

- **Default is fine for most projects.** Haiku for planning, Sonnet for code. You don't need to change it.
- **Use Opus for the Lead.** Code reviews benefit most from premium reasoning. Opus catches edge cases Sonnet misses.
- **Haiku is underrated for tests.** Test writing doesn't require deep reasoning — Haiku is fast and accurate enough.
- **Per-agent overrides are cheap.** Put Opus on the Lead, Haiku on the Tester, Sonnet on everyone else. Balanced budget.
- **Model config is in `.ai-team/model-config.json`.** Commit it so your team uses the same models.
