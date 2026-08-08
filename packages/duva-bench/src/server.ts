/**
 * The researcher's three views: define a study, watch it run, read what it found.
 *
 * Mounted alongside squad-lab's server rather than inside it. The plan permits
 * either, and this way duva-bench keeps importing only the modules the boundary
 * allows — squad-lab's `server.ts` is not one of them, and adding it would drag
 * the lab's experiment model into a package whose whole point is that it can be
 * lifted out.
 *
 * **The ADP token never leaves this process.** The browser reads ADP through a
 * small set of literal paths on this server, with owner and repo resolved from
 * the study the request names — never from the query string. A token handed to
 * a page is a token in a browser history, a proxy log and an extension; and a
 * proxy that forwarded arbitrary paths would turn one leaked `repo:read` into a
 * read of every repository on the instance.
 *
 * **Frames are numbered by the file, not by the connection.** The scheduler's
 * `progress.jsonl` is already append-only and already the source of truth, so a
 * frame's id is its line number in that file. That is what lets `Last-Event-ID`
 * survive both a page refresh and a server restart: an in-memory counter would
 * restart at 1 and hand the browser frames it has already rendered under ids it
 * has already seen. Two rules follow, both easy to get wrong and both honoured
 * here — subscribe before reading, so a reconnecting client cannot lose a frame
 * appended in the gap; and heartbeats carry no id, because they exist to hold a
 * connection open, not to be replayed.
 */

import { readFileSync, existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import { parse as parseYaml } from 'yaml';

import { graderSha256, loadStudyFile, resolveFrom } from './study-file.js';
import {
  armDigest,
  preRegistrationReading,
  shortDigest,
  studyDigest,
  parseStudy,
  type Study,
} from './study.js';
import { collectOutcomes, includedTrials, noiseFloors, observationsOf } from './analysis.js';
import { buildReport } from './report.js';
import { intentTitle } from './scheduler.js';
import { findGoalByTitle, getRun, runTrajectory, type AdpEndpoint } from '@deduvafork/squad-lab/adp';
import { PAGE } from './server-page.js';

export interface BenchServerOptions {
  /** ADP base URL, owner and repo. The token stays here. */
  adp: { baseUrl: string; owner: string; repo: string; token: string };
  /** Where studies were run — `progress.jsonl` lives under here. */
  root: string;
  /** Study specs the Define view can open. */
  specs?: string[];
}

// ─── The frame log ───────────────────────────────────────────────────────

export interface ProgressFrame {
  /** Line number in `progress.jsonl`, 1-based. Monotonic, and the file's. */
  seq: number;
  data: unknown;
}

/** Read frames after `afterSeq`. Line number is the id, so this is a slice. */
export function readFrames(path: string, afterSeq = 0): ProgressFrame[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n');
  const frames: ProgressFrame[] = [];
  for (let i = afterSeq; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      frames.push({ seq: i + 1, data: JSON.parse(line) });
    } catch {
      // A torn last line is a crash mid-append, not a corrupt log. The next
      // read picks it up whole.
    }
  }
  return frames;
}

export const sseFrame = (frame: ProgressFrame): string =>
  `id: ${frame.seq}\nevent: progress\ndata: ${JSON.stringify(frame.data)}\n\n`;

/** No id: a heartbeat must never advance a client's resume point. */
export const sseHeartbeat = (): string =>
  `event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;

// ─── The server ──────────────────────────────────────────────────────────

function endpoint(options: BenchServerOptions): AdpEndpoint {
  return {
    baseUrl: options.adp.baseUrl,
    token: options.adp.token,
    owner: options.adp.owner,
    repo: options.adp.repo,
  };
}

export function createBenchServer(options: BenchServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const progressPath = join(options.root, 'progress.jsonl');

  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(PAGE);
  });

  app.get('/api/config', async () => ({
    root: options.root,
    specs: options.specs ?? [],
    adp: { baseUrl: options.adp.baseUrl, owner: options.adp.owner, repo: options.adp.repo },
  }));

  // ── Define ──────────────────────────────────────────────────────────
  app.post('/api/validate', async (request) => {
    const body = request.body as { spec?: unknown; text?: string; file?: string; basePath?: string };

    // Text is the editor's own contents, which are usually YAML. Parsing it
    // here rather than in the browser is the whole reason the editor can accept
    // the same format the file on disk uses.
    //
    // `basePath` matters more than it looks. A task's paths and its grader's
    // sha256 are all in the study digest, so editing a spec in the browser
    // without resolving them would show a digest the scheduler will never use —
    // a Define view that quietly disagrees with the thing it is defining.
    let result;
    if (body.text !== undefined && body.text.trim()) {
      try {
        const raw = parseYaml(body.text) as { tasks?: Array<Record<string, unknown>> };
        const base = body.basePath && (options.specs ?? []).includes(body.basePath) ? body.basePath : undefined;
        if (base && Array.isArray(raw?.tasks)) {
          for (const task of raw.tasks) {
            if (typeof task.grader !== 'string') continue;
            try {
              task.graderSha256 = graderSha256(resolveFrom(base, task.grader));
            } catch {
              // Left as written; the schema reports a bad digest better than a
              // message about a file the author never mentioned.
            }
          }
        }
        result = parseStudy(raw);
      } catch (error) {
        return {
          ok: false,
          errors: [{ path: '(text)', message: error instanceof Error ? error.message : String(error) }],
        };
      }
    } else if (body.file) {
      result = loadStudyFile(body.file);
    } else {
      result = parseStudy(body.spec);
    }

    if (!result.ok) return { ok: false, errors: result.errors };

    const study = result.study;
    const digest = studyDigest(study);
    const reading = preRegistrationReading(study.preRegistration);
    return {
      ok: true,
      digest,
      short: shortDigest(digest),
      trials: study.tasks.length * study.arms.length * study.preRegistration.repetitions,
      arms: study.arms.map((a) => ({
        id: a.id,
        digest: armDigest(a),
        harness: a.harness,
        topology: a.topology,
        toolset: `${a.toolset.name}/${a.toolset.docsGrade}`,
        twinned: a.toolset.twinSeed !== undefined,
      })),
      tasks: study.tasks.map((t) => ({ id: t.id, graderSha256: t.graderSha256 })),
      // Both readings, so an amendment is a diff a reader can see rather than
      // a claim they have to take on trust.
      preRegistration: {
        registered: reading.registered,
        current: reading.current,
        registeredDigest: reading.registeredDigest,
        currentDigest: reading.currentDigest,
        amended: reading.amended,
      },
    };
  });

  // ── Monitor ─────────────────────────────────────────────────────────
  app.get('/api/progress', async () => ({ frames: readFrames(progressPath) }));

  app.get('/api/progress/stream', (request, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    // `Last-Event-ID` is the browser's own reconnect header; the query
    // parameter is for a client driving the seam deliberately.
    const header = request.headers['last-event-id'];
    const fromQuery = (request.query as { lastEventId?: string }).lastEventId;
    let sent = Number(
      (Array.isArray(header) ? header[0] : header) ?? fromQuery ?? 0,
    );
    if (!Number.isFinite(sent) || sent < 0) sent = 0;

    // Subscribe *before* reading. A client that read the file and then
    // subscribed would lose any frame appended in between; buffering first and
    // filtering by seq produces neither a gap nor a duplicate.
    let closed = false;
    const push = (): void => {
      if (closed) return;
      for (const frame of readFrames(progressPath, sent)) {
        reply.raw.write(sseFrame(frame));
        sent = frame.seq;
      }
    };

    let watcher: FSWatcher | undefined;
    try {
      if (existsSync(progressPath)) watcher = watch(progressPath, () => push());
    } catch {
      // Watch is an optimisation; the poll below is the guarantee.
    }
    const poll = setInterval(push, 500);
    const beat = setInterval(() => {
      if (!closed) reply.raw.write(sseHeartbeat());
    }, 15_000);

    push();

    request.raw.on('close', () => {
      closed = true;
      clearInterval(poll);
      clearInterval(beat);
      watcher?.close();
    });
  });

  // ── Analyze ─────────────────────────────────────────────────────────
  app.get('/api/report', async (request, reply) => {
    const { file } = request.query as { file?: string };
    if (!file) return reply.code(400).send({ error: 'missing ?file=' });

    const loaded = loadStudyFile(file);
    if (!loaded.ok) return reply.code(400).send({ error: 'invalid study', errors: loaded.errors });

    const study: Study = loaded.study;
    const ep = endpoint(options);
    const digest = studyDigest(study);

    const intents = new Map<string, string>();
    for (const task of study.tasks) {
      const goal = await findGoalByTitle(ep, intentTitle(digest, task.id));
      if (goal) intents.set(task.id, goal.intentId);
    }
    if (intents.size === 0) return reply.code(404).send({ error: 'no intents — has this study run?' });

    const outcomes = await collectOutcomes(ep, study, intents);
    const axes = [...new Set(includedTrials(outcomes).flatMap((t) => Object.keys(t.axes)))].sort();
    return buildReport({
      study,
      outcomes,
      noiseFloors: noiseFloors(observationsOf(outcomes, study), axes),
      stats: {},
      statsUnavailable: 'statistics are computed by `duva-bench report`, not by the browser',
    });
  });

  // ── The read proxy: literal paths only ──────────────────────────────
  //
  // Owner and repo come from this server's configuration, never from the
  // request. A proxy that forwarded a caller-supplied path would turn one
  // leaked token into a read of every repository on the instance.
  app.get('/api/run/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      return await getRun(endpoint(options), runId);
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/run/:runId/trajectory', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      return await runTrajectory(endpoint(options), runId, '?limit=500');
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/spec', async (request, reply) => {
    const { file } = request.query as { file?: string };
    // Only specs this server was started with. An arbitrary path here would be
    // a file-read primitive wearing a study's name.
    if (!file || !(options.specs ?? []).includes(file)) {
      return reply.code(403).send({ error: 'unknown spec' });
    }
    if (!existsSync(file)) return reply.code(404).send({ error: 'not found' });
    return { file, text: readFileSync(file, 'utf8'), modified: statSync(file).mtime.toISOString() };
  });

  return app;
}

export async function startBenchServer(
  options: BenchServerOptions & { port?: number; host?: string },
): Promise<{ app: FastifyInstance; url: string; close: () => Promise<void> }> {
  const app = createBenchServer(options);
  const host = options.host ?? '127.0.0.1';
  const address = await app.listen({ port: options.port ?? 0, host });
  return { app, url: address, close: () => app.close() };
}

export { resolveFrom };
