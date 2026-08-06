/**
 * The lab's HTTP surface: experiments, a live stream, and a read-only window
 * onto ADP.
 *
 * Loopback, and **no auth in the slice** — stated rather than implied. What it
 * does not do is more load-bearing than what it does:
 *
 *  - **It stores nothing ADP can answer.** `/summary` is a join: every number
 *    comes from `runs/compare` untouched. Re-deriving totals here would create
 *    a second source of truth, and the two would disagree in front of someone.
 *  - **The ADP token never leaves this process.** The browser reads ADP through
 *    six literal paths, with owner and repo resolved from the experiment record
 *    server-side. That is what makes "ADP registers no CORS plugin" a decision
 *    rather than a gap — and it matters because ADP has no per-repo authz, so a
 *    leaked `repo:read` token reads every repository on the instance.
 *  - **Creating an experiment starts no processes.** A bad grader path or an
 *    unreachable ADP fails before any model is invoked, which is the difference
 *    between a typo and a bill.
 */

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareRuns,
  getRun,
  listEvals,
  runStats,
  runTrajectory,
  verifyRun,
  type AdpEndpoint,
} from './adp.js';
import {
  cancelExperiment,
  createExperiment,
  experimentDir,
  launchExperiment,
  listExperiments,
  loadExperiment,
  loadVariantStates,
  regradeVariant,
  type CreateExperimentInput,
  type Experiment,
} from './experiments.js';
import { ExperimentEventLog, sseFrame, sseHeartbeat } from './event-log.js';
import { assertSeparateIdentities } from './grader.js';
import { buildSummary } from './summary.js';

export interface LabServerOptions {
  /** Opens runs and appends trajectory. */
  token: string;
  /**
   * Reports evals, and must be a different principal. Held only here — never
   * passed to a variant child, never to the grader.
   */
  evalToken?: string;
  adpUrl: string;
  /** Vendor credentials by variant id or provider, forwarded to each child. */
  credentials?: Record<string, { geminiApiKey?: string; anthropicApiKey?: string }>;
  host?: string;
  port?: number;
  logger?: boolean;
  /** How often an idle SSE connection is reassured. */
  heartbeatMs?: number;
  /** Built SPA to serve at `/app/`. Defaults to `web/dist`; skipped if absent. */
  webRoot?: string;
}

/** The endpoint for one experiment's repository, with the server's own token. */
function endpointFor(exp: Experiment, token: string): AdpEndpoint {
  return { baseUrl: exp.adp.url, token, owner: exp.adp.owner, repo: exp.adp.repo };
}

export function createLabServer(options: LabServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  /**
   * One frame log per experiment, for this server only, keyed by the file it
   * writes to.
   *
   * Not module-global, and not keyed by experiment id alone: the log's whole
   * job is to hold a live subscriber list against a particular file, and an id
   * does not name a file. Two labs in one process — or one process whose
   * `SQUAD_LAB_HOME` differs from the last one's — would otherwise share a
   * cache entry pointing at a path that is no longer theirs, and replay would
   * quietly return nothing.
   */
  const logs = new Map<string, ExperimentEventLog>();
  const logFor = (experimentId: string): ExperimentEventLog => {
    const path = join(experimentDir(experimentId), 'events.jsonl');
    let log = logs.get(path);
    if (!log) {
      log = new ExperimentEventLog(path);
      logs.set(path, log);
    }
    return log;
  };

  const experimentOr404 = (req: FastifyRequest, reply: FastifyReply): Experiment | undefined => {
    const { id } = req.params as { id: string };
    try {
      return loadExperiment(id);
    } catch {
      reply.code(404).send({ message: `no experiment ${id}` });
      return undefined;
    }
  };

  // --- experiments ---------------------------------------------------------

  app.post('/api/experiments', async (req, reply) => {
    const body = req.body as Omit<CreateExperimentInput, 'adp'> & { adp?: { owner: string; repo: string } };
    if (!body?.adp?.owner || !body?.adp?.repo) {
      reply.code(422).send({ message: 'adp.owner and adp.repo are required' });
      return;
    }
    const experiment = await createExperiment({
      ...body,
      adp: {
        baseUrl: options.adpUrl,
        token: options.token,
        owner: body.adp.owner,
        repo: body.adp.repo,
        tokenEnv: 'SQUAD_LAB_ADP_TOKEN',
      },
    });
    logFor(experiment.id).append({ type: 'experiment', data: { status: 'draft', id: experiment.id } });
    reply.code(201).send(experiment);
  });

  app.get('/api/experiments', async () => ({ experiments: listExperiments() }));

  app.get('/api/experiments/:id', async (req, reply) => {
    const experiment = experimentOr404(req, reply);
    if (!experiment) return;
    reply.send({ experiment, variants: loadVariantStates(experiment.id) });
  });

  // 202 and return: a launch runs for minutes, and holding the request open for
  // it would make the browser's timeout the experiment's deadline.
  app.post('/api/experiments/:id/launch', async (req, reply) => {
    const experiment = experimentOr404(req, reply);
    if (!experiment) return;
    if (experiment.status === 'running') {
      reply.code(409).send({ message: `experiment ${experiment.id} is already running` });
      return;
    }
    if (experiment.grader && !options.evalToken) {
      reply.code(422).send({
        message: 'this experiment has a grader but the lab holds no eval identity',
      });
      return;
    }

    const log = logFor(experiment.id);
    log.append({ type: 'experiment', data: { status: 'running' } });

    void launchExperiment(experiment, {
      token: options.token,
      ...(options.evalToken ? { evalToken: options.evalToken } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
      onPhase: (variantId, phase, detail) =>
        log.append({ type: 'phase', variantId, data: { phase, detail } }),
      // Verbatim, plus the variant it came from. No lab-side renaming, so
      // `runtime/event-payloads.ts` is the contract for both sides.
      onEvent: (variantId, event) => log.append({ type: 'bus', variantId, data: event }),
      onGrade: (variantId, grade) =>
        log.append({
          type: 'variant',
          variantId,
          data: { grade: { outcome: grade.outcome, specDigest: grade.specDigest, axes: grade.axes } },
        }),
    })
      .then((results) => {
        for (const r of results) {
          log.append({ type: 'variant', variantId: r.variantId, data: { outcome: r.outcome, runId: r.runId } });
        }
        log.append({ type: 'experiment', data: { status: loadExperiment(experiment.id).status } });
      })
      .catch((err: Error) => {
        log.append({ type: 'experiment', data: { status: 'failed', error: err.message } });
      });

    reply.code(202).send({ id: experiment.id, status: 'running' });
  });

  app.post('/api/experiments/:id/cancel', async (req, reply) => {
    const experiment = experimentOr404(req, reply);
    if (!experiment) return;
    const result = await cancelExperiment(experiment.id, { token: options.token });
    logFor(experiment.id).append({ type: 'experiment', data: { status: 'cancelled', ...result } });
    reply.send(result);
  });

  app.post('/api/experiments/:id/variants/:vid/regrade', async (req, reply) => {
    const experiment = experimentOr404(req, reply);
    if (!experiment) return;
    if (!options.evalToken) {
      reply.code(422).send({ message: 'the lab holds no eval identity, so it cannot report a score' });
      return;
    }
    const { vid } = req.params as { vid: string };
    try {
      const grade = await regradeVariant(experiment.id, vid, {
        token: options.token,
        evalToken: options.evalToken,
      });
      logFor(experiment.id).append({ type: 'variant', variantId: vid, data: { grade } });
      reply.send(grade);
    } catch (err) {
      reply.code(422).send({ message: (err as Error).message });
    }
  });

  app.get('/api/experiments/:id/summary', async (req, reply) => {
    const experiment = experimentOr404(req, reply);
    if (!experiment) return;
    reply.send(await buildSummary(experiment, endpointFor(experiment, options.token)));
  });

  // --- the live stream -----------------------------------------------------

  app.get('/api/experiments/:id/stream', async (req, reply) => {
    const experiment = experimentOr404(req, reply);
    if (!experiment) return;

    // `Last-Event-ID` is the browser's own reconnect header; the query
    // parameter is for anything driving this by hand, `curl -N` included.
    const header = req.headers['last-event-id'];
    const query = (req.query as { last_event_id?: string }).last_event_id;
    const afterSeq = Number(header ?? query ?? 0) || 0;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nothing between here and the browser should buffer a stream whose
      // entire value is arriving as it happens.
      'X-Accel-Buffering': 'no',
    });

    const unsubscribe = logFor(experiment.id).replayAndFollow(afterSeq, (frame) => {
      reply.raw.write(sseFrame(frame));
    });

    // Heartbeats carry no `id:` — they keep the socket warm without advancing
    // the client's resume point past a frame that never had content.
    const heartbeat = setInterval(() => reply.raw.write(sseHeartbeat()), options.heartbeatMs ?? 15_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    // Never resolves: the reply is the stream, and returning would end it.
    return new Promise<void>(() => {});
  });

  // --- the ADP read proxy --------------------------------------------------

  // Six literal patterns, not a wildcard. A pass-through would hand a browser
  // the lab's token by proxy and let it reach every route ADP serves, including
  // the ones that write.
  const proxy = (
    path: string,
    read: (ep: AdpEndpoint, req: FastifyRequest) => Promise<unknown>,
  ): void => {
    app.get(path, async (req, reply) => {
      const experimentId = (req.query as { experiment?: string }).experiment;
      if (!experimentId) {
        // Owner and repo are never taken from the caller: they are read off an
        // experiment this lab actually ran, which bounds what the proxy can
        // reach to what the lab already knows about.
        reply.code(422).send({ message: 'experiment= is required, and names the repository to read' });
        return;
      }
      let experiment: Experiment;
      try {
        experiment = loadExperiment(experimentId);
      } catch {
        reply.code(404).send({ message: `no experiment ${experimentId}` });
        return;
      }
      try {
        reply.send(await read(endpointFor(experiment, options.token), req));
      } catch (err) {
        const status = (err as { status?: number }).status ?? 502;
        reply.code(status).send({ message: (err as Error).message });
      }
    });
  };

  const runId = (req: FastifyRequest) => (req.params as { runId: string }).runId;

  proxy('/adp/runs/compare', async (ep, req) => {
    const intentId = (req.query as { intent_id?: string }).intent_id;
    if (!intentId) throw Object.assign(new Error('intent_id is required'), { status: 422 });
    return compareRuns(ep, intentId);
  });
  proxy('/adp/runs/:runId', async (ep, req) => getRun(ep, runId(req)));
  proxy('/adp/runs/:runId/trajectory', async (ep, req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 200) || 200;
    return runTrajectory(ep, runId(req), `?limit=${Math.min(limit, 500)}`);
  });
  proxy('/adp/runs/:runId/stats', async (ep, req) => runStats(ep, runId(req)));
  proxy('/adp/runs/:runId/verify', async (ep, req) => verifyRun(ep, runId(req)));
  proxy('/adp/runs/:runId/evals', async (ep, req) => listEvals(ep, runId(req)));

  // --- the SPA -------------------------------------------------------------

  // Registered last, so it can never shadow an API route. Absent when the web
  // build has not been run: the server is fully usable headless, and a missing
  // `dist/` is a build step nobody ran rather than a broken lab.
  const webRoot = options.webRoot ?? defaultWebRoot();
  if (existsSync(join(webRoot, 'index.html'))) {
    void app.register(fastifyStatic, { root: webRoot, prefix: '/app/' });
    // Client-side routing means `/app/e/:id/summary` is a real URL a user can
    // paste or refresh on — which is the reason for using a router at all — so
    // anything under `/app` that is not a file resolves to the shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/app')) return reply.sendFile('index.html', webRoot);
      return reply.code(404).send({ message: 'Not Found' });
    });
    app.get('/', async (_req, reply) => reply.redirect('/app/'));
  }

  return app;
}

/** `packages/squad-lab/web/dist`, from either `src/` or the built `dist/`. */
function defaultWebRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'web', 'dist'), join(here, '..', '..', 'web', 'dist')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return join(here, '..', 'web', 'dist');
}

export interface StartedLabServer {
  app: FastifyInstance;
  url: string;
  close: () => Promise<void>;
}

/**
 * Boot the lab.
 *
 * The identity check happens here, before anything is listening, because a lab
 * that discovers its two tokens are one principal *after* an experiment has run
 * has already produced evals that look like evidence and are self-reports.
 */
export async function startLabServer(options: LabServerOptions): Promise<StartedLabServer> {
  if (options.evalToken) {
    const base = { baseUrl: options.adpUrl, owner: 'lab', repo: 'lab' };
    await assertSeparateIdentities(
      { ...base, token: options.token },
      { ...base, token: options.evalToken },
    );
  }

  const app = createLabServer(options);
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 7317;
  await app.listen({ host, port });
  const address = app.server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return { app, url: `http://${host}:${boundPort}`, close: () => app.close() };
}
