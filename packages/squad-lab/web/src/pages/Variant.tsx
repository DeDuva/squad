/**
 * One variant, drilled into: what it scored, and the evidence underneath.
 *
 * Every number on the summary reaches this page, because a score with no path
 * to the metrics that produced it is a claim. `separately_authorized` is shown
 * on the run header for the same reason — it is what makes the score evidence
 * rather than a self-report, and it should not be something you have to know
 * to look for.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  getEvals,
  getExperiment,
  getRun,
  getStats,
  getSummary,
  getTrajectory,
  regradeVariant,
  type VariantState,
} from '../api.js';

/** The run ADP says belongs to this variant, when the lab's own record is thin. */
async function runIdFromSummary(experimentId: string, variantId: string): Promise<string | undefined> {
  try {
    const summary = await getSummary(experimentId);
    return summary.rows.find((row) => (row.variantId ?? row.labels?.['variant']) === variantId)?.runId;
  } catch {
    return undefined;
  }
}

export default function Variant() {
  const { id = '', vid = '' } = useParams();
  const [state, setState] = useState<VariantState | null>(null);
  const [run, setRun] = useState<Record<string, any> | null>(null);
  const [stats, setStats] = useState<Record<string, any> | null>(null);
  const [evals, setEvals] = useState<Record<string, any>[]>([]);
  const [trajectory, setTrajectory] = useState<Record<string, any>[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    getExperiment(id).then(async (r) => {
      const variant = r.variants.find((v) => v.id === vid) ?? null;
      setState(variant);
      // The lab's own record first, then ADP's. The fallback matters because
      // the run→variant mapping lives in ADP (as the run's `external_ref` and
      // labels), so a lab that lost its local state — restarted, or never
      // launched this run itself — can still drill into it.
      const runId = variant?.runId || (await runIdFromSummary(id, vid));
      if (!runId) return;
      try {
        const [runRow, statsRow, evalRows, traj] = await Promise.all([
          getRun(id, runId),
          getStats(id, runId),
          getEvals(id, runId),
          getTrajectory(id, runId),
        ]);
        setState((prev) => (prev ? { ...prev, runId } : { id: vid, phase: 'unknown', runId }));
        setRun(runRow);
        setStats(statsRow);
        setEvals(evalRows.evals);
        setTrajectory(traj.events ?? []);
      } catch (err) {
        setError((err as Error).message);
      }
    }, (e: Error) => setError(e.message));
  }, [id, vid]);

  if (error) return <p className="error">{error}</p>;
  if (!state) return <p className="muted">loading…</p>;

  return (
    <section>
      <header className="page-head">
        <h1>{vid}</h1>
        <nav>
          <Link to={`/e/${id}/summary`}>← summary</Link>
          {state.runId && <Link to={`/e/${id}/v/${vid}/verify`}>verify →</Link>}
          <button onClick={() => regradeVariant(id, vid).then(() => location.reload(), (e: Error) => setError(e.message))}>
            regrade
          </button>
        </nav>
      </header>

      <dl className="facts">
        <dt>phase</dt>
        <dd>{state.phase}</dd>
        <dt>outcome</dt>
        <dd>{state.outcome ?? '—'}</dd>
        <dt>run</dt>
        <dd><code>{state.runId ?? '—'}</code></dd>
        <dt>final sha</dt>
        <dd><code>{state.finalSha ?? '— nothing was pushed'}</code></dd>
        {run?.['labels'] && (
          <>
            <dt>labels</dt>
            <dd>
              {/* Attested, not annotated: these ride inside the run's signed
                  predicate, so the vendor is part of what was signed. */}
              <code>{JSON.stringify(run['labels'])}</code>
            </dd>
          </>
        )}
      </dl>

      <h2>Axes</h2>
      {evals.length === 0 && <p className="muted">Not measured — no eval was recorded for this run.</p>}
      <div className="cards">
        {evals.map((e) => (
          <article key={String(e['id'])} className="card" data-testid={`axis-${e['name']}`}>
            <h3>{String(e['name'])}</h3>
            <p className="score-big">{e['score'] === null ? '— not measured' : Number(e['score']).toFixed(2)}</p>
            <p className={e['separately_authorized'] ? 'ok' : 'error'}>
              {e['separately_authorized']
                ? `separately authorized — reported by ${e['reporter_principal']}`
                : 'SELF-REPORTED — the identity that ran this also scored it'}
            </p>
            <p className="muted small">
              rubric <code title={String(e['spec_digest'])}>{String(e['spec_digest']).slice(0, 12)}</code>
            </p>
          </article>
        ))}
      </div>

      {state.grade?.reason && <p className="muted">grader: {state.grade.reason}</p>}

      <h2>Tools</h2>
      {/* Registered and backend-supplied are listed apart, never summed: one
          backend ships its own file tools and the other does not. */}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>tool</th>
              <th>calls</th>
              <th>failures</th>
            </tr>
          </thead>
          <tbody>
            {((stats?.['tools'] as Record<string, any>[]) ?? []).map((t) => (
              <tr key={String(t['name'])}>
                <td><code>{String(t['name'])}</code></td>
                <td>{Number(t['count'])}</td>
                <td>{Number(t['failures'] ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Trajectory <span className="muted small">({trajectory.length} events)</span></h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>seq</th>
              <th>kind</th>
              <th>type</th>
              <th>model</th>
              <th>tokens</th>
              <th>status</th>
            </tr>
          </thead>
          <tbody>
            {trajectory.slice(0, 200).map((e, i) => (
              <tr key={i}>
                <td>{String(e['seq'] ?? i)}</td>
                <td>{String(e['kind'] ?? '')}</td>
                <td>{String(e['type'] ?? '')}</td>
                <td>{String(e['model'] ?? '')}</td>
                <td>
                  {Number(e['tokens_in'] ?? 0)} / {Number(e['tokens_out'] ?? 0)}
                </td>
                <td>{String(e['status'] ?? '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
