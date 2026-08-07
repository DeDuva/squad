/**
 * Set a goal, pick the vendors, name a grader.
 *
 * Creating is deliberately separate from launching: this call files the issue
 * that mints the intent and materialises the workspace, and **starts no
 * processes**. A bad grader path or an unreachable ADP fails here, before any
 * model is invoked — the difference between a typo and a bill.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { createExperiment } from '../api.js';

// Provider × tier, matching the SDK's vendor registry. Held here rather than
// fetched because a picker that cannot render without the server is a worse
// first-run experience than one that occasionally lags the registry.
const VENDORS: Record<string, string[]> = {
  anthropic: ['premium', 'standard', 'fast'],
  gemini: ['premium', 'standard', 'fast'],
};

type HarnessImpl = 'squad-native' | 'ai-sdk';

/**
 * A picked cell. `model` empty means "the vendor's model for this tier".
 *
 * `key` exists because provider+tier is not unique: the comparison this lab is
 * for is the *same* model under two harnesses, which is two rows that agree on
 * everything the chip grid can express.
 */
interface Pick {
  key: string;
  provider: string;
  tier: string;
  model?: string;
  harnessImpl?: HarnessImpl;
}

let nextKey = 0;
const pick = (provider: string, tier: string, rest: Partial<Pick> = {}): Pick => ({
  key: `v${(nextKey += 1)}`,
  provider,
  tier,
  ...rest,
});

export default function NewExperiment() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [seed, setSeed] = useState('');
  const [grader, setGrader] = useState('');
  const [primaryAxis, setPrimaryAxis] = useState('acceptance');
  const [owner, setOwner] = useState('lab');
  const [repo, setRepo] = useState('');
  const [deadlineMs, setDeadlineMs] = useState(900_000);
  const [picked, setPicked] = useState<Pick[]>([
    pick('anthropic', 'standard'),
    pick('gemini', 'standard'),
  ]);
  // The experiment-wide harness. A variant may override the impl below, which
  // is how one model runs under both arms in a single comparison.
  const [harnessImpl, setHarnessImpl] = useState<HarnessImpl>('squad-native');
  const [toolSurface, setToolSurface] = useState<'registered' | 'native'>('registered');
  const [systemPrompt, setSystemPrompt] = useState<'charter-only' | 'backend-preset'>('charter-only');
  const [maxToolRounds, setMaxToolRounds] = useState(120);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // A chip removes *every* row for that cell, so clicking an on-chip off always
  // clears it rather than peeling one duplicate at a time.
  const toggle = (provider: string, tier: string) => {
    setPicked((prev) => {
      const has = prev.some((v) => v.provider === provider && v.tier === tier);
      return has
        ? prev.filter((v) => !(v.provider === provider && v.tier === tier))
        : [...prev, pick(provider, tier)];
    });
  };

  const amend = (key: string, patch: Partial<Pick>) => {
    setPicked((prev) => prev.map((v) => (v.key === key ? { ...v, ...patch } : v)));
  };

  /**
   * A second row for the same cell.
   *
   * This is how the four-cell matrix gets written down without a flag: pin one
   * model, duplicate the row, and set the two harnesses. The chip grid cannot
   * express it, because the whole point is two variants that agree on every
   * axis the grid has.
   */
  const duplicate = (key: string) => {
    setPicked((prev) => {
      const at = prev.findIndex((v) => v.key === key);
      if (at < 0) return prev;
      const source = prev[at]!;
      const copy = pick(source.provider, source.tier, {
        ...(source.model ? { model: source.model } : {}),
        // The copy takes the *other* arm, since comparing a row with itself is
        // the one thing duplicating it cannot be for.
        harnessImpl: source.harnessImpl === 'ai-sdk' ? 'squad-native' : 'ai-sdk',
      });
      return [...prev.slice(0, at + 1), copy, ...prev.slice(at + 1)];
    });
  };

  const remove = (key: string) => setPicked((prev) => prev.filter((v) => v.key !== key));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const experiment = await createExperiment({
        goal: { title, body },
        adp: { owner, repo },
        seed: { repoUrl: seed },
        // Empty strings are dropped rather than sent: an unset model means "the
        // vendor's model for this tier", and `model: ''` would pin nothing under
        // a name that claims to.
        variants: picked.map((v) => ({
          provider: v.provider,
          tier: v.tier,
          ...(v.model?.trim() ? { model: v.model.trim() } : {}),
          ...(v.harnessImpl ? { harnessImpl: v.harnessImpl } : {}),
        })),
        ...(grader ? { grader: { path: grader, primaryAxis } } : {}),
        limits: { deadlineMs },
        harness: { harnessImpl, toolSurface, systemPrompt, maxToolRounds },
      });
      navigate(`/e/${experiment.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <header className="page-head">
        <h1>New experiment</h1>
      </header>

      <form onSubmit={submit} className="form">
        <label>
          Goal
          <input value={title} onChange={(e) => setTitle(e.target.value)} required data-testid="goal-title" />
        </label>
        <label>
          Brief — the agents read this from the ADP issue, not from a copy
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} data-testid="goal-body" />
        </label>

        <div className="row">
          <label>
            ADP owner
            <input value={owner} onChange={(e) => setOwner(e.target.value)} required />
          </label>
          <label>
            ADP repo
            <input value={repo} onChange={(e) => setRepo(e.target.value)} required data-testid="repo" />
          </label>
        </div>

        <label>
          Seed repository — cloned once per variant, never shared
          <input value={seed} onChange={(e) => setSeed(e.target.value)} required data-testid="seed" />
        </label>

        <fieldset>
          <legend>Variants</legend>
          <div className="vendors">
            {Object.entries(VENDORS).map(([provider, tiers]) =>
              tiers.map((tier) => {
                const on = picked.some((v) => v.provider === provider && v.tier === tier);
                return (
                  <button
                    type="button"
                    key={`${provider}:${tier}`}
                    className={on ? 'chip chip-on' : 'chip'}
                    onClick={() => toggle(provider, tier)}
                    data-testid={`vendor-${provider}-${tier}`}
                  >
                    {provider} · {tier}
                  </button>
                );
              }),
            )}
          </div>
          <p className="muted small">
            Two variants on one vendor is a legitimate experiment — two tiers, two harnesses, or two
            attempts.
          </p>

          {picked.length > 0 && (
            <table className="variant-config">
              <thead>
                <tr>
                  <th>variant</th>
                  <th>model — blank means the vendor's model for this tier</th>
                  <th>harness</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {picked.map((v) => (
                  <tr key={v.key}>
                    <td className="mono">
                      {v.provider} · {v.tier}
                    </td>
                    <td>
                      <input
                        value={v.model ?? ''}
                        placeholder="e.g. claude-sonnet-5"
                        onChange={(e) => amend(v.key, { model: e.target.value })}
                        data-testid={`model-${v.key}`}
                      />
                    </td>
                    <td>
                      <select
                        value={v.harnessImpl ?? ''}
                        onChange={(e) =>
                          amend(v.key, {
                            harnessImpl: (e.target.value || undefined) as HarnessImpl | undefined,
                          })
                        }
                        data-testid={`harness-${v.key}`}
                      >
                        <option value="">inherit — {harnessImpl}</option>
                        <option value="squad-native">squad-native</option>
                        <option value="ai-sdk">ai-sdk</option>
                      </select>
                    </td>
                    <td className="row-actions">
                      <button
                        type="button"
                        onClick={() => duplicate(v.key)}
                        title="another run of this cell under the other harness"
                        data-testid={`duplicate-${v.key}`}
                      >
                        + arm
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(v.key)}
                        title="drop this variant"
                        data-testid={`remove-${v.key}`}
                      >
                        −
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small">
            Pin the model when the result is one you intend to cite: a tier is an alias, and it moves
            under you. <strong>+ arm</strong> adds the same cell again under the other harness — one
            model, two loops, which is the comparison the summary bands rather than ranks across.
          </p>
        </fieldset>

        <fieldset>
          <legend>Harness</legend>
          <div className="row">
            <label>
              Agent loop
              <select
                value={harnessImpl}
                onChange={(e) => setHarnessImpl(e.target.value as HarnessImpl)}
                data-testid="harness-impl"
              >
                <option value="squad-native">squad-native — the vendor SDK on each side</option>
                <option value="ai-sdk">ai-sdk — one neutral loop for every provider</option>
              </select>
            </label>
            <label>
              Tool surface
              <select
                value={toolSurface}
                onChange={(e) => setToolSurface(e.target.value as 'registered' | 'native')}
                data-testid="tool-surface"
              >
                <option value="registered">registered — the lab's tools only</option>
                <option value="native">native — plus whatever the backend brings</option>
              </select>
            </label>
          </div>
          <div className="row">
            <label>
              System prompt
              <select
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value as 'charter-only' | 'backend-preset')}
                data-testid="system-prompt"
              >
                <option value="charter-only">charter-only — identical text for both vendors</option>
                <option value="backend-preset">backend-preset — the backend's own, plus the charter</option>
              </select>
            </label>
            <label>
              Max tool rounds
              <input
                type="number"
                value={maxToolRounds}
                onChange={(e) => setMaxToolRounds(Number(e.target.value))}
                min={1}
                data-testid="max-tool-rounds"
              />
            </label>
          </div>
          <p className="muted small">
            The defaults are the comparable configuration. <code>native</code> tools and{' '}
            <code>backend-preset</code> give one vendor six more tools and a system message the other
            never sees — a legitimate experiment, but not a cross-vendor comparison.
          </p>
        </fieldset>

        <div className="row">
          <label>
            Grader — a file printing JSON on stdout
            <input value={grader} onChange={(e) => setGrader(e.target.value)} data-testid="grader" />
          </label>
          <label>
            Primary axis — the one reported under gate <code>score</code>
            <input value={primaryAxis} onChange={(e) => setPrimaryAxis(e.target.value)} />
          </label>
        </div>

        <label>
          Deadline per variant (ms)
          <input
            type="number"
            value={deadlineMs}
            onChange={(e) => setDeadlineMs(Number(e.target.value))}
            min={60_000}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy || picked.length === 0} data-testid="create">
          {busy ? 'creating…' : 'create — no processes start yet'}
        </button>
      </form>
    </section>
  );
}
