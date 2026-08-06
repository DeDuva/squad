/**
 * The live board: one column per variant, fed by the lab's SSE stream.
 *
 * Everything here is derived from frames as they arrive rather than polled,
 * which is the difference between watching a run and refreshing a page at it.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { cancelExperiment, getExperiment, launchExperiment, type Experiment, type VariantState } from '../api.js';
import { useStream, type LabFrame } from '../useStream.js';

const PHASES = ['queued', 'preparing', 'opening-run', 'running', 'quiesced', 'committing', 'recording', 'closing', 'done'];

export default function Board() {
  const { id = '' } = useParams();
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [variants, setVariants] = useState<VariantState[]>([]);
  const [error, setError] = useState('');
  const { frames, connected } = useStream(id);

  const refresh = () =>
    getExperiment(id).then(
      (r) => {
        setExperiment(r.experiment);
        setVariants(r.variants);
      },
      (e: Error) => setError(e.message),
    );

  useEffect(() => {
    void refresh();
  }, [id]);

  // A `variant` or `experiment` frame means the durable records moved, so the
  // board re-reads them rather than trying to reconstruct their state from the
  // stream — the file is the truth, the stream is the notification.
  useEffect(() => {
    const last = frames.at(-1);
    if (last && (last.type === 'variant' || last.type === 'experiment')) void refresh();
  }, [frames.length]);

  const byVariant = useMemo(() => {
    const map = new Map<string, LabFrame[]>();
    for (const frame of frames) {
      if (!frame.variantId) continue;
      map.set(frame.variantId, [...(map.get(frame.variantId) ?? []), frame]);
    }
    return map;
  }, [frames]);

  if (error) return <p className="error">{error}</p>;
  if (!experiment) return <p className="muted">loading…</p>;

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>{experiment.goal.title}</h1>
          <p className="muted">
            {experiment.status} · intent {experiment.adp.intentId.slice(0, 8)} · issue #
            {experiment.adp.issueNumber} · <span className={connected ? 'live' : 'muted'}>{connected ? 'live' : 'offline'}</span>
          </p>
        </div>
        <nav>
          <Link to={`/e/${id}/summary`}>exec summary →</Link>
          <button onClick={() => launchExperiment(id).then(refresh, (e: Error) => setError(e.message))}>
            launch
          </button>
          <button onClick={() => cancelExperiment(id).then(refresh, (e: Error) => setError(e.message))}>
            cancel
          </button>
        </nav>
      </header>

      <div className="board">
        {experiment.variants.map((plan) => {
          const state = variants.find((v) => v.id === plan.id);
          const lane = byVariant.get(plan.id) ?? [];
          const phase = state?.phase ?? 'queued';
          const bus = lane.filter((f) => f.type === 'bus');
          const tokens = bus.reduce((n, f) => n + tokensOf(f), 0);
          const tools = bus.filter((f) => kindOf(f) === 'tool_call');

          return (
            <article key={plan.id} className="lane" data-testid={`lane-${plan.id}`}>
              <header>
                <h2>{plan.id}</h2>
                <span className={`pill pill-${phase}`}>{phase}</span>
              </header>
              <p className="muted">
                {plan.provider}
                {plan.model ? ` · ${plan.model}` : ''}
              </p>

              <div className="meters">
                <div>
                  <strong>{tokens.toLocaleString()}</strong>
                  <span>tokens</span>
                </div>
                <div>
                  <strong>{bus.length}</strong>
                  <span>events</span>
                </div>
                <div>
                  <strong>{tools.length}</strong>
                  <span>tool calls</span>
                </div>
              </div>

              <ol className="progress">
                {PHASES.map((p) => (
                  <li key={p} className={PHASES.indexOf(phase) >= PHASES.indexOf(p) ? 'reached' : ''}>
                    {p}
                  </li>
                ))}
              </ol>

              <ul className="ticker">
                {lane
                  .slice(-12)
                  .reverse()
                  .map((frame) => (
                    <li key={frame.seq}>
                      <code>{frame.type}</code> {describe(frame)}
                    </li>
                  ))}
              </ul>

              {state?.runId && (
                <p>
                  <Link to={`/e/${id}/v/${plan.id}`}>run {state.runId.slice(0, 8)} →</Link>
                </p>
              )}
              {state?.grade && (
                <p className={state.grade.outcome === 'scored' ? '' : 'muted'}>
                  grade: {state.grade.outcome}
                  {state.grade.reason ? ` (${state.grade.reason})` : ''}
                </p>
              )}
              {state?.error && <p className="error small">{state.error}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}

const payload = (frame: LabFrame) => (frame.data ?? {}) as Record<string, any>;

function kindOf(frame: LabFrame): string {
  return String(payload(frame)['type'] ?? '');
}

function tokensOf(frame: LabFrame): number {
  const p = payload(frame)['payload'] as Record<string, any> | undefined;
  return Number(p?.['tokensIn'] ?? 0) + Number(p?.['tokensOut'] ?? 0);
}

function describe(frame: LabFrame): string {
  const p = payload(frame);
  if (frame.type === 'phase') return String(p['phase'] ?? '');
  if (frame.type === 'bus') return `${p['type'] ?? ''} ${p['agentName'] ?? ''}`.trim();
  return JSON.stringify(p).slice(0, 90);
}
