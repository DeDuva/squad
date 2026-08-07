/**
 * The exec summary, which refuses to blend.
 *
 * One row per variant, one column per axis, ranked independently. There is no
 * mean, no weighted score, and the word "overall" does not appear — a single
 * number would have hidden the exact result this exists to show: two vendors
 * tied on the module while one shipped a repository whose own suite fails.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { getSummary } from '../api.js';
import {
  axisColumns,
  describeWarning,
  formatCost,
  formatTools,
  ranksDisagree,
  type SummaryView,
} from '../lib/summary-view.js';

export default function Summary() {
  const { id = '' } = useParams();
  const [summary, setSummary] = useState<SummaryView | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getSummary(id).then(setSummary, (e: Error) => setError(e.message));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!summary) return <p className="muted">loading…</p>;

  const columns = axisColumns(summary);
  const disagree = ranksDisagree(columns);

  return (
    <section>
      <header className="page-head">
        <h1>Exec summary</h1>
        <nav>
          <Link to={`/e/${id}`}>← live board</Link>
        </nav>
      </header>

      {disagree && (
        // Promoted from a paragraph in a report to a first-class UI state: it
        // is the reason the product exists, so burying it would be the product
        // failing.
        <p className="banner banner-warn" data-testid="disagreement">
          ⚠ Rankings disagree across axes — there is no single winner.
        </p>
      )}

      <div className="scroll">
        <table className="summary">
          <thead>
            <tr>
              <th>variant</th>
              {columns.map((column) => (
                <th key={column.axis} className={column.mismatched ? 'greyed' : ''}>
                  <div>{column.axis}</div>
                  {/* The rubric, printed rather than implied: two scores under
                      two digests are two measurements, not a ranking. */}
                  <div className="digest" title={column.specDigest}>
                    digest {column.specDigest?.slice(0, 8) ?? '—'}
                  </div>
                  {column.note && <div className="note">{column.note}</div>}
                </th>
              ))}
              <th>trajectory</th>
              <th>tokens</th>
              <th className="not-sortable" title="not sortable — see the cost note">
                cost
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((row) => {
              const variantId = row.variantId ?? row.runId;
              const cost = formatCost(row);
              const tools = formatTools(row);
              return (
                <tr key={row.runId} data-testid={`row-${variantId}`}>
                  <td>
                    <Link to={`/e/${id}/v/${variantId}`}>{variantId}</Link>
                    <div className="muted">{row.labels?.['model'] ?? row.provider ?? ''}</div>
                    {/* The arm, attested on the run rather than remembered by
                        the lab. Without it two rows differing only by harness
                        read as one configuration scoring twice. */}
                    {row.labels?.['harness_impl'] && (
                      <div className="digest">{row.labels['harness_impl']}</div>
                    )}
                  </td>
                  {columns.map((column) => {
                    const cell = column.cells.find((c) => c.runId === row.runId)!;
                    return (
                      <td key={column.axis} className={column.mismatched ? 'greyed' : ''}>
                        {/* Every score links to the metrics that produced it —
                            a number with no path to its evidence is a claim. */}
                        <Link to={`/e/${id}/v/${variantId}`} className="score">
                          {cell.rank !== null && <span className="rank">#{cell.rank}</span>} {cell.display}
                        </Link>
                      </td>
                    );
                  })}
                  <td>
                    <div>{row.events} ev</div>
                    <div className="muted" title={tools.caveat ? 'not like-for-like — see below' : undefined}>
                      {tools.headline} · {tools.detail}
                    </div>
                  </td>
                  <td>
                    {/* Tokens get the prominent slot: they are comparable
                        across vendors in a way cost is not. */}
                    <div>{row.tokensIn.toLocaleString()} in</div>
                    <div className="muted">{row.tokensOut.toLocaleString()} out</div>
                  </td>
                  <td className={cost.unpriced ? 'unpriced' : ''} title={cost.title}>
                    {cost.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {summary.warnings.length > 0 && (
        <ul className="warnings">
          {summary.warnings.map((warning, i) => (
            <li key={i}>{describeWarning(warning)}</li>
          ))}
        </ul>
      )}

      <p className="muted small">
        Latency is reported as time-to-quiescence beside the summed per-event duration; wall-clock is
        never presented as per-agent latency. Cost is not sortable, and a vendor with no published
        rate reads <code>unpriced</code> rather than <code>$0.00</code>.
      </p>
    </section>
  );
}
