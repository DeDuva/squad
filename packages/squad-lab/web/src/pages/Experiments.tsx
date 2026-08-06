/**
 * Every experiment this lab knows about.
 *
 * No scores here: an experiment's results live in ADP, and re-deriving a
 * headline number for a list view would be the second source of truth the
 * whole design avoids. The list links to the summary; the summary joins.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { listExperiments, type Experiment } from '../api.js';

export default function Experiments() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    listExperiments().then((r) => setExperiments(r.experiments), (e: Error) => setError(e.message));
  }, []);

  return (
    <section>
      <header className="page-head">
        <h1>Experiments</h1>
        <nav>
          <Link to="/new" className="button">
            new experiment
          </Link>
        </nav>
      </header>

      {error && <p className="error">{error}</p>}
      {experiments.length === 0 && !error && <p className="muted">Nothing yet. Set a goal to start.</p>}

      <ul className="cards">
        {experiments.map((exp) => (
          <li key={exp.id} data-testid={`experiment-${exp.id}`}>
            <Link to={`/e/${exp.id}`}>
              <h2>{exp.goal.title}</h2>
            </Link>
            <p className="muted">
              <span className={`pill pill-${exp.status}`}>{exp.status}</span> {exp.variants.length} variant
              {exp.variants.length === 1 ? '' : 's'} · {exp.variants.map((v) => v.provider).join(', ')}
            </p>
            <p className="muted small">
              {exp.adp.owner}/{exp.adp.repo} · intent {exp.adp.intentId.slice(0, 8)} ·{' '}
              {new Date(exp.createdAt).toLocaleString()}
            </p>
            <p>
              <Link to={`/e/${exp.id}/summary`}>exec summary →</Link>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
