/**
 * The lab's HTTP surface, from the browser's side.
 *
 * Everything ADP-shaped goes through `/adp/*`, which is the lab's read proxy —
 * six literal paths, owner and repo injected server-side. The browser never
 * holds an ADP token and cannot name a repository, which is what makes ADP
 * registering no CORS plugin a decision rather than a gap.
 */

import type { SummaryView } from './lib/summary-view.js';

export interface VariantPlan {
  id: string;
  provider: string;
  model?: string;
  tier?: string;
  externalRef: string;
}

export interface Experiment {
  id: string;
  createdAt: string;
  status: 'draft' | 'running' | 'complete' | 'failed';
  goal: { title: string; body: string };
  adp: { url: string; owner: string; repo: string; issueNumber: number; intentId: string };
  grader?: { path: string; sha256: string; primaryAxis?: string };
  variants: VariantPlan[];
}

export interface VariantState {
  id: string;
  phase: string;
  runId?: string;
  finalSha?: string | null;
  outcome?: string;
  error?: string;
  grade?: { outcome: string; reason?: string; specDigest?: string; axes?: string[] };
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

export const listExperiments = () => json<{ experiments: Experiment[] }>('/api/experiments');

export const getExperiment = (id: string) =>
  json<{ experiment: Experiment; variants: VariantState[] }>(`/api/experiments/${id}`);

export const createExperiment = (body: unknown) =>
  json<Experiment>('/api/experiments', { method: 'POST', body: JSON.stringify(body) });

export const launchExperiment = (id: string) =>
  json<{ id: string }>(`/api/experiments/${id}/launch`, { method: 'POST' });

export const cancelExperiment = (id: string) =>
  json<unknown>(`/api/experiments/${id}/cancel`, { method: 'POST' });

export const regradeVariant = (id: string, vid: string) =>
  json<unknown>(`/api/experiments/${id}/variants/${vid}/regrade`, { method: 'POST' });

export const getSummary = (id: string) => json<SummaryView>(`/api/experiments/${id}/summary`);

// --- the ADP read proxy ------------------------------------------------------

const adp = <T,>(path: string, experiment: string, query = '') =>
  json<T>(`/adp/${path}?experiment=${encodeURIComponent(experiment)}${query}`);

export const getRun = (experiment: string, runId: string) =>
  adp<Record<string, unknown>>(`runs/${runId}`, experiment);

export const getTrajectory = (experiment: string, runId: string) =>
  adp<{ events: Record<string, unknown>[]; total: number }>(`runs/${runId}/trajectory`, experiment);

export const getStats = (experiment: string, runId: string) =>
  adp<Record<string, unknown>>(`runs/${runId}/stats`, experiment);

export const getVerify = (experiment: string, runId: string) =>
  adp<Record<string, unknown>>(`runs/${runId}/verify`, experiment);

export const getEvals = (experiment: string, runId: string) =>
  adp<{ evals: Record<string, unknown>[] }>(`runs/${runId}/evals`, experiment);
