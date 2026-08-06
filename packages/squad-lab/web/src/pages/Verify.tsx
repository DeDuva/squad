/**
 * Whether the run's own record holds up.
 *
 * This is the bottom of every drill-down. A score is evidence only if the
 * trajectory it was bound to verifies, so the page shows each check by name —
 * and `broke_at_seq` when one does not, because "verification failed" without
 * a location is not actionable.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { getExperiment, getSummary, getVerify } from '../api.js';

/** Same fallback as the variant page: ADP holds the run→variant mapping. */
async function runIdFromSummary(experimentId: string, variantId: string): Promise<string | undefined> {
  try {
    const summary = await getSummary(experimentId);
    return summary.rows.find((row) => (row.variantId ?? row.labels?.['variant']) === variantId)?.runId;
  } catch {
    return undefined;
  }
}

const CHECKS = ['ok', 'chains_ok', 'emitters_ok', 'envelope_verified', 'trajectory_digest_matches'] as const;

export default function Verify() {
  const { id = '', vid = '' } = useParams();
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getExperiment(id).then(async (r) => {
      const runId = r.variants.find((v) => v.id === vid)?.runId || (await runIdFromSummary(id, vid));
      if (!runId) {
        setError('this variant produced no run to verify');
        return;
      }
      try {
        setResult(await getVerify(id, runId));
      } catch (err) {
        setError((err as Error).message);
      }
    }, (e: Error) => setError(e.message));
  }, [id, vid]);

  if (error) return <p className="error">{error}</p>;
  if (!result) return <p className="muted">verifying…</p>;

  return (
    <section>
      <header className="page-head">
        <h1>Verify — {vid}</h1>
        <nav>
          <Link to={`/e/${id}/v/${vid}`}>← variant</Link>
        </nav>
      </header>

      <div className="checks">
        {CHECKS.map((check) => (
          <div key={check} className={result[check] ? 'check ok' : 'check bad'} data-testid={`check-${check}`}>
            <strong>{result[check] ? '✓' : '✗'}</strong> {check}
          </div>
        ))}
      </div>

      <h2>Sessions</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>session</th>
              <th>events</th>
              <th>chain</th>
              <th>emitter</th>
              <th>broke at</th>
            </tr>
          </thead>
          <tbody>
            {((result['sessions'] as Record<string, any>[]) ?? []).map((s) => (
              <tr key={String(s['session_id'])}>
                <td><code>{String(s['session_id']).slice(0, 8)}</code></td>
                <td>{Number(s['event_count'])}</td>
                <td className={s['ok'] ? 'ok' : 'error'}>{s['ok'] ? 'intact' : String(s['reason'] ?? 'broken')}</td>
                <td className={s['emitter_complete'] ? 'ok' : 'muted'}>
                  {s['emitter_tracked'] ? (s['emitter_complete'] ? 'contiguous' : `gap at ${s['emitter_first_gap']}`) : 'untracked'}
                </td>
                {/* Where, not just whether: a broken chain with no sequence
                    number is a fact nobody can act on. */}
                <td>{s['broke_at_seq'] === null ? '—' : String(s['broke_at_seq'])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
