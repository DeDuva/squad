/**
 * Routes.
 *
 * `react-router` rather than an in-memory route union: the drill-down is three
 * levels deep and a shareable URL for "variant v2's trajectory" is the whole
 * point of having built it.
 */

import { Link, Route, Routes } from 'react-router-dom';

import Board from './pages/Board.js';
import Experiments from './pages/Experiments.js';
import NewExperiment from './pages/NewExperiment.js';
import Summary from './pages/Summary.js';
import Variant from './pages/Variant.js';
import Verify from './pages/Verify.js';

export default function App() {
  return (
    <div className="app">
      <header className="chrome">
        <Link to="/" className="brand">
          squad <strong>lab</strong>
        </Link>
        <span className="muted small">one goal · N vendors · recorded in ADP</span>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Experiments />} />
          <Route path="/new" element={<NewExperiment />} />
          <Route path="/e/:id" element={<Board />} />
          <Route path="/e/:id/summary" element={<Summary />} />
          <Route path="/e/:id/v/:vid" element={<Variant />} />
          <Route path="/e/:id/v/:vid/verify" element={<Verify />} />
        </Routes>
      </main>
    </div>
  );
}
