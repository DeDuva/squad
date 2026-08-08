/**
 * knock-knock — Real LLM Knock-Knock Joke Exchange
 *
 * Two agent sessions trade knock-knock jokes forever.
 * Demonstrates: SquadClientWithPool, CastingEngine, StreamingPipeline,
 * and live LLM-generated comedy.
 *
 * Requires credentials for whichever backend the SDK resolves — see
 * `provider` in .squad/config.json, or the SQUAD_PROVIDER env var.
 */

import { CastingEngine, StreamingPipeline } from '@bradygaster/squad-sdk';
import type { StreamDelta } from '@bradygaster/squad-sdk';
import { SquadClientWithPool } from '@bradygaster/squad-sdk/client';
import type { SquadSession } from '@bradygaster/squad-sdk/client';

// ── Agent Setup ──────────────────────────────────────────────────────

interface AgentInfo {
  name: string;
  role: string;
  systemPrompt: string;
  sessionId?: string;
  session?: SquadSession;
}

const TELLER_PROMPT = `You are a comedian performing knock-knock jokes. When prompted, tell ONE knock-knock joke. Keep the format: "Knock knock!" then wait for the response, then deliver the setup and punchline. Be creative and funny. Keep responses short — just the joke, no commentary.`;

const RESPONDER_PROMPT = `You are the audience for a knock-knock joke. Respond naturally to each part. Say "Who's there?" after "Knock knock!" and "[setup] who?" after the setup line. After the punchline, react with a short genuine response (laugh, groan, or witty comeback). Keep responses to one line.`;

// ── Main Loop ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const casting = new CastingEngine();
  const team = casting.castTeam({
    universe: 'usual-suspects',
    requiredRoles: ['developer', 'tester'],
    teamSize: 2,
  });

  const [agentA, agentB] = team;

  const agents: AgentInfo[] = [
    {
      name: agentA.name,
      role: agentA.role,
      systemPrompt: TELLER_PROMPT,
    },
    {
      name: agentB.name,
      role: agentB.role,
      systemPrompt: RESPONDER_PROMPT,
    },
  ];

  console.log('\n🎭 Knock-Knock Comedy Hour (Live LLM Edition)\n');
  console.log(`   ${agents[0].name} (Teller) vs. ${agents[1].name} (Responder)\n`);
  console.log('   Connecting...\n');

  // The client resolves its backend and credentials itself, in the order
  // documented on SquadClientOptions: .squad/config.json, then SQUAD_PROVIDER,
  // then the default. Nothing to pass here, and no env var this sample can
  // usefully pre-check — connect() reports whatever is actually missing.
  const client = new SquadClientWithPool({});

  try {
    await client.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Connection failed: ${msg}\n`);
    console.error('Check the provider configured in .squad/config.json or SQUAD_PROVIDER,\n');
    console.error('and that credentials for that backend are available.\n');
    process.exit(1);
  }

  // Create sessions
  const pipeline = new StreamingPipeline();
  pipeline.onDelta((event) => {
    process.stdout.write(event.content);
  });

  for (const agent of agents) {
    const session = await client.createSession({
      streaming: true,
      systemMessage: { mode: 'append', content: agent.systemPrompt },
      onPermissionRequest: () => ({ kind: 'approve-once' }),
    });
    agent.sessionId = session.sessionId;
    agent.session = session;
    pipeline.attachToSession(session.sessionId);
  }

  console.log('   ✓ Connected. Let the jokes begin!\n');

  // Infinite joke loop — full 5-turn knock-knock exchange
  let jokeCount = 0;

  while (true) {
    const teller = agents[jokeCount % 2];
    const responder = agents[(jokeCount + 1) % 2];
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Turn 1: Teller opens with "Knock knock!"
    process.stdout.write(`🎭 ${teller.name}: `);
    const opener = await sendAndCapture(pipeline, teller, 'Start a new knock-knock joke. Just say "Knock knock!"');
    console.log();
    await pause(800);

    // Turn 2: Responder says "Who's there?"
    process.stdout.write(`🎭 ${responder.name}: `);
    const whoseThere = await sendAndCapture(pipeline, responder, opener);
    console.log();
    await pause(800);

    // Turn 3: Teller gives the setup name
    process.stdout.write(`🎭 ${teller.name}: `);
    const setup = await sendAndCapture(pipeline, teller, whoseThere);
    console.log();
    await pause(800);

    // Turn 4: Responder says "[setup] who?"
    process.stdout.write(`🎭 ${responder.name}: `);
    const setupWho = await sendAndCapture(pipeline, responder, setup);
    console.log();
    await pause(800);

    // Turn 5: Teller delivers the punchline
    process.stdout.write(`🎭 ${teller.name}: `);
    await sendAndCapture(pipeline, teller, setupWho);
    console.log('\n');

    // Swap roles for next joke
    agents.reverse();
    jokeCount++;

    await pause(3000);
  }
}

// ── Helper: Send message and capture full response ──────────────────

async function sendAndCapture(
  pipeline: StreamingPipeline,
  agent: AgentInfo,
  message: string,
): Promise<string> {
  const sessionId = agent.sessionId!;
  const session = agent.session!;
  let captured = '';

  pipeline.markMessageStart(sessionId);

  const handler = (event: { type: string; [key: string]: unknown }) => {
    if (event.type === 'message_delta') {
      const content =
        (event['deltaContent'] as string) ??
        (event['delta'] as string) ??
        (event['content'] as string) ??
        '';
      if (content) {
        captured += content;
        void pipeline.processEvent({
          type: 'message_delta',
          sessionId,
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
    let fallback = '';
    if (session.sendAndWait) {
      const result = await session.sendAndWait({ prompt: message }, 30_000);
      // Extract content from sendAndWait result (same pattern as shell)
      const data = (result as Record<string, unknown> | undefined)?.['data'] as Record<string, unknown> | undefined;
      fallback = typeof data?.['content'] === 'string' ? (data['content'] as string) : '';
      // If result itself is a string, use that
      if (!fallback && typeof result === 'string') fallback = result;
    } else {
      await session.sendMessage({ prompt: message });
    }

    // Use streaming content if captured, otherwise fall back to sendAndWait result
    if (!captured && fallback) {
      captured = fallback;
      process.stdout.write(captured);
    }
  } finally {
    session.off('message_delta', handler);
  }

  return captured.trim();
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
