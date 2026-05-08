/**
 * streaming-chat — Interactive Multi-Agent Streaming Chat
 *
 * Squad SDK sample for MVP Summit.
 * Demonstrates: SquadClientWithPool, CastingEngine, SessionPool,
 * EventBus, StreamingPipeline, and readline-based interactive chat.
 *
 * Run with `npx tsx index.ts` (live Copilot) or set SQUAD_DEMO_MODE=true
 * for a self-contained demo that simulates streaming without auth.
 */

import * as readline from 'node:readline';

// SDK barrel exports: CastingEngine, StreamingPipeline
import { CastingEngine, StreamingPipeline } from '@deduvafork/squad-sdk';
import type { StreamDelta } from '@deduvafork/squad-sdk';

// Client sub-path exports: SquadClientWithPool, EventBus
import { SquadClientWithPool, EventBus } from '@deduvafork/squad-sdk/client';

// ────────────────────────────────────────────────────────────────────────────
// Agent definitions
// ────────────────────────────────────────────────────────────────────────────

interface AgentInfo {
  name: string;
  role: string;
  color: string;
  keywords: string[];
  sessionId?: string;
  systemPrompt: string;
}

const AGENTS: AgentInfo[] = [
  {
    name: 'McManus',
    role: 'Backend',
    color: '\x1b[36m',   // cyan
    keywords: ['api', 'server', 'database', 'backend', 'endpoint', 'rest', 'sql', 'auth'],
    systemPrompt: 'You are McManus, a bold backend engineer. Keep answers concise and code-focused.',
  },
  {
    name: 'Kobayashi',
    role: 'Frontend',
    color: '\x1b[35m',   // magenta
    keywords: ['ui', 'frontend', 'component', 'css', 'react', 'style', 'layout', 'ux'],
    systemPrompt: 'You are Kobayashi, a precise frontend designer. Respond with clean, visual solutions.',
  },
  {
    name: 'Fenster',
    role: 'Tester',
    color: '\x1b[33m',   // yellow
    keywords: ['test', 'bug', 'qa', 'coverage', 'assert', 'fixture', 'mock', 'spec'],
    systemPrompt: 'You are Fenster, an eccentric tester. You find bugs nobody else can see.',
  },
];

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

// ────────────────────────────────────────────────────────────────────────────
// Routing — match message to an agent by keyword
// ────────────────────────────────────────────────────────────────────────────

function routeMessage(message: string): AgentInfo {
  const lower = message.toLowerCase();
  for (const agent of AGENTS) {
    if (agent.keywords.some((kw) => lower.includes(kw))) {
      return agent;
    }
  }
  // Default to the first agent (Backend)
  return AGENTS[0];
}

// ────────────────────────────────────────────────────────────────────────────
// Demo mode — simulated streaming when Copilot auth is unavailable
// ────────────────────────────────────────────────────────────────────────────

const DEMO_RESPONSES: Record<string, string[]> = {
  Backend: [
    "Sure thing. I'd scaffold that with an Express router — `app.post('/api/users', validate(schema), async (req, res) => { ... })`. Want me to wire up the Postgres pool too?",
    "The connection pool is the bottleneck. Switch to `pg-pool` with `max: 20` and add a health-check endpoint at `/api/health` that pings the DB.",
    "For auth, I'd use JWT with short-lived access tokens (15 min) and a refresh token rotation. The middleware hooks into `req.user` before any route handler fires.",
  ],
  Frontend: [
    "Clean layout here: a flex container with `gap: 1rem`, the sidebar at `width: 280px`, and the main content area filling the rest. Dark mode toggles via a CSS custom property on `:root`.",
    "I'd reach for a compound component pattern — `<Tabs>`, `<Tabs.List>`, `<Tabs.Panel>`. Keep state in context, expose it via `useTabsContext()`. No prop drilling.",
    "For the loading skeleton, use `@keyframes shimmer` with a linear gradient. It's lighter than a spinner and feels more polished during data fetches.",
  ],
  Tester: [
    "That function has no edge-case coverage. What happens when `input` is an empty string? Or `null`? I'd add at least 3 boundary tests before shipping.",
    "The mock is too loose — `vi.fn().mockResolvedValue({})` hides real failures. Use `vi.fn().mockResolvedValue({ id: 1, name: 'test' })` so the shape matches prod.",
    "Coverage says 94% but the missing 6% is the error path. Add a test that forces the API call to reject and verify the error boundary catches it.",
  ],
};

function getDemoResponse(role: string): string {
  const responses = DEMO_RESPONSES[role] ?? DEMO_RESPONSES['Backend'];
  return responses[Math.floor(Math.random() * responses.length)];
}

async function simulateStreaming(
  pipeline: StreamingPipeline,
  agent: AgentInfo,
  _message: string,
): Promise<void> {
  const sessionId = agent.sessionId ?? `demo-${agent.role.toLowerCase()}`;
  const response = getDemoResponse(agent.role);
  const words = response.split(' ');

  pipeline.markMessageStart(sessionId);

  for (let i = 0; i < words.length; i++) {
    const chunk = (i === 0 ? '' : ' ') + words[i];
    const delta: StreamDelta = {
      type: 'message_delta',
      sessionId,
      agentName: agent.name,
      content: chunk,
      index: i,
      timestamp: new Date(),
    };
    await pipeline.processEvent(delta);
    // Simulate token-by-token delay (40–80 ms per word)
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 40));
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Live mode — real Copilot SDK sessions
// ────────────────────────────────────────────────────────────────────────────

async function sendLiveMessage(
  client: SquadClientWithPool,
  pipeline: StreamingPipeline,
  agent: AgentInfo,
  message: string,
): Promise<void> {
  const sessionId = agent.sessionId;
  if (!sessionId) {
    console.error(`  ${DIM}(no session for ${agent.name})${RESET}`);
    return;
  }

  pipeline.markMessageStart(sessionId);

  // Retrieve the session from the pool and send
  const sessions = await client.listSessions();
  const meta = sessions.find((s) => s.sessionId === sessionId);
  if (!meta) {
    console.error(`  ${DIM}(session ${sessionId} not found)${RESET}`);
    return;
  }

  // Resume the session to get a SquadSession handle, then send
  const session = await client.resumeSession(sessionId);

  // Register delta listener to feed the pipeline
  const handler = (event: { type: string; [key: string]: unknown }) => {
    if (event.type === 'message_delta') {
      const content =
        (event['deltaContent'] as string) ??
        (event['delta'] as string) ??
        (event['content'] as string) ??
        '';
      if (content) {
        void pipeline.processEvent({
          type: 'message_delta',
          sessionId: sessionId!,
          agentName: agent.name,
          content,
          index: typeof event['index'] === 'number' ? event['index'] : 0,
          timestamp: new Date(),
        });
      }
    }
  };
  session.on('message_delta', handler);

  try {
    if (session.sendAndWait) {
      await session.sendAndWait({ prompt: message }, 120_000);
    } else {
      await session.sendMessage({ prompt: message });
    }
  } finally {
    session.off('message_delta', handler);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const demoMode = process.env['SQUAD_DEMO_MODE'] === 'true';

  // ── Banner ──
  console.log();
  console.log(`${BOLD}  ╔═══════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}  ║   🎬  Squad Streaming Chat  ·  MVP Summit    ║${RESET}`);
  console.log(`${BOLD}  ╚═══════════════════════════════════════════════╝${RESET}`);
  console.log();

  // ── Cast agents ──
  const casting = new CastingEngine();
  const cast = casting.castTeam({
    universe: 'usual-suspects',
    requiredRoles: ['developer', 'designer', 'tester'],
  });
  console.log(`  ${DIM}Cast:${RESET}`);
  for (const member of cast) {
    const match = AGENTS.find((a) => a.name === member.name);
    if (match) {
      console.log(`    ${match.color}● ${member.name}${RESET} — ${member.role} ${DIM}(${member.personality})${RESET}`);
    }
  }
  console.log();

  // ── Streaming pipeline ──
  const pipeline = new StreamingPipeline();
  let currentLine = '';

  pipeline.onDelta((event) => {
    currentLine += event.content;
    process.stdout.write(event.content);
  });

  // ── Client + sessions ──
  let client: SquadClientWithPool | null = null;
  const eventBus = new EventBus();

  if (!demoMode) {
    try {
      client = new SquadClientWithPool({ pool: { maxConcurrent: 5 } });
      await client.connect();

      // Create a session per agent
      for (const agent of AGENTS) {
        const session = await client.createSession({
          streaming: true,
          systemMessage: { mode: 'append', content: agent.systemPrompt },
        });
        agent.sessionId = session.sessionId;
        pipeline.attachToSession(session.sessionId);
      }

      // Wire EventBus
      client.eventBus.onAny((event) => {
        void eventBus.emit({
          type: event.type as 'session.created',
          sessionId: event.sessionId,
          payload: event.payload,
          timestamp: event.timestamp,
        });
      });

      console.log(`  ${DIM}Connected to Copilot — live mode${RESET}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ${DIM}⚠ Could not connect to Copilot: ${msg}${RESET}`);
      console.log(`  ${DIM}  Falling back to demo mode (simulated streaming)${RESET}`);
      client = null;
    }
  }

  if (!client) {
    // Demo-mode session IDs for pipeline attachment
    for (const agent of AGENTS) {
      agent.sessionId = `demo-${agent.role.toLowerCase()}`;
      pipeline.attachToSession(agent.sessionId);
    }
    console.log(`  ${DIM}Running in demo mode — responses are simulated${RESET}`);
  }

  console.log(`  ${DIM}Type a message. Use /quit to exit.${RESET}`);
  console.log(`  ${DIM}Keyword routing: api/server → Backend · ui/react → Frontend · test/bug → Tester${RESET}`);
  console.log();

  // ── Readline loop ──
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${BOLD}  ◆ you >${RESET} `,
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      continue;
    }

    if (input === '/quit') {
      console.log(`\n  ${DIM}👋 Goodbye!${RESET}\n`);
      break;
    }

    // Route
    const agent = routeMessage(input);
    console.log(`\n  ${agent.color}${BOLD}${agent.name}${RESET} ${DIM}(${agent.role})${RESET}`);
    process.stdout.write('  ');
    currentLine = '';

    // Stream response
    if (client) {
      await sendLiveMessage(client, pipeline, agent, input);
    } else {
      await simulateStreaming(pipeline, agent, input);
    }

    console.log('\n');
    rl.prompt();
  }

  // ── Cleanup ──
  rl.close();
  if (client) {
    await client.shutdown();
  }
  pipeline.clear();
}

// Run
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
