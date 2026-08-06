import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.js';
import './styles.css';

// `basename` matches the Fastify mount and Vite's `base`. Without it every
// in-app link would resolve against the origin root and 404 the moment the SPA
// is served from anywhere but `/`.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/app">
      <App />
    </BrowserRouter>
  </StrictMode>,
);
