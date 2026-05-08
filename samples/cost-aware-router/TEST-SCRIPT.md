# TEST-SCRIPT.md — Cost-Aware Router Live Demo

Use this script for the **MVP Summit** live walkthrough.

---

## Pre-flight

```bash
cd samples/cost-aware-router
npm install
npm run build          # Verify TypeScript compiles clean
```

Expected: zero errors, `dist/` directory created.

---

## Step 1 — Run the Demo

```bash
npm start
```

### What to point out

1. **Banner** — the demo prints a branded header. Look for "Squad SDK — Cost-Aware Router Demo."

2. **Model catalogue** — three tiers (fast / standard / premium) with per-1k-token pricing. Note how `claude-haiku-4.5` is ~20× cheaper than `claude-opus-4.6`.

3. **Task routing** — five tasks scroll through:
   - *Typo Fix*: the routing config has an explicit `tier: 'direct'` rule for the word "typo" — show that config overrides kick in first.
   - *Docs Update*: keyword "List" matches the lightweight pattern → fast model.
   - *Feature Impl*: "Implement a new feature" matches the full-tier pattern → premium model.
   - *Arch Review*: "Full review" matches the full-tier pattern → premium model.
   - *Security Audit*: "Security audit" matches the full-tier pattern → premium model.

4. **Budget bar** — watch the visual fill up after each task. The bar turns yellow at 70% and red at 90%.

5. **Budget warnings** — after the heavier tasks, look for the yellow/red warning lines.

---

## Step 2 — Walk Through the Output

### Tier distribution chart

After all tasks, a bar chart shows how many tasks landed on each tier. Highlight that only one task used the cheapest tier — the router doesn't under-provision.

### Agent cost table

Aligned columns: Agent, Model, Tokens In/Out, Cost, Turns. Note that Fenster (security audit) consumed the most tokens.

### Final report

- Total spend vs. budget
- Remaining budget in green
- Token totals

---

## Step 3 — Code Walkthrough (if time)

Open `index.ts` and highlight:

1. **Lines 10–14** — imports from `@deduvafork/squad-sdk`
2. **Lines ~130–170** — task definitions with simulated token counts
3. **The routing call** — `selectResponseTier(task.message, config)` — one line does all the work
4. **CostTracker.recordUsage()** — accumulates per-agent data
5. **Budget bar** — pure terminal art, no dependencies

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '@deduvafork/squad-sdk'` | Run `npm install` from repo root first, or `npm link @deduvafork/squad-sdk` |
| TypeScript errors | Ensure `typescript >= 5.7` and Node >= 20 |
| No color output | Terminal must support ANSI escape codes (iTerm2, Windows Terminal, VS Code) |

---

## Key Talking Points

- **Zero LLM calls** — this demo runs entirely locally. The tier selection and cost tracking are deterministic code, not prompt engineering.
- **Config-driven overrides** — the `routing.rules` array lets you pin specific patterns to specific tiers.
- **Load-aware downgrade** — pass `currentLoad` in the context to see tiers auto-downgrade under pressure.
- **CostTracker is standalone** — wire it to an EventBus in production, or call `recordUsage()` manually like we do here.
