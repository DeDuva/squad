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
  const [picked, setPicked] = useState<{ provider: string; tier: string }[]>([
    { provider: 'anthropic', tier: 'standard' },
    { provider: 'gemini', tier: 'standard' },
  ]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (provider: string, tier: string) => {
    setPicked((prev) => {
      const hit = prev.findIndex((v) => v.provider === provider && v.tier === tier);
      return hit >= 0 ? prev.filter((_, i) => i !== hit) : [...prev, { provider, tier }];
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const experiment = await createExperiment({
        goal: { title, body },
        adp: { owner, repo },
        seed: { repoUrl: seed },
        variants: picked,
        ...(grader ? { grader: { path: grader, primaryAxis } } : {}),
        limits: { deadlineMs },
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
            Two variants on one vendor is a legitimate experiment — two tiers, or two attempts.
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
