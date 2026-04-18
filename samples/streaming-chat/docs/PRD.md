# Streaming Chat — SDK Sample PRD

## Overview
Build an interactive multi-agent chat. User types messages. SDK routes them to the right agents. Responses stream token-by-token in real-time. This shows the event-driven core of Squad: sessions are persistent, routing is deterministic, and you see live progress as agents think.

## Target Audience
Developers building interactive squad applications (Discord bots, chat CLIs, web dashboards). Anyone needing real-time agent feedback and event-driven coordination.

## SDK APIs Demonstrated

| API | Module | What It Shows |
|-----|--------|--------------|
| `SquadClient` / `SquadClientWithPool` | `client` | Create and manage persistent agent sessions |
| `createSession()` | `client` | Spawn a new agent session with a task |
| `StreamingPipeline` | `runtime/streaming` | Register handlers for message deltas, reasoning deltas, usage events |
| `EventBus` | `runtime/event-bus` | Pub/sub for squad-wide events (agent:task-complete, agent:error, etc.) |
| `Router` | `coordinator` | Match incoming messages to the right agent |
| `StreamDelta`, `ReasoningDelta`, `UsageEvent` | `runtime/streaming` | Typed event payloads for real-time monitoring |

## Code Highlights

**Initialize client and event pipeline:**
```typescript
import { SquadClient, StreamingPipeline, EventBus } from '@squad/sdk';

const client = new SquadClient({ squadPath: '.squad' });
const eventBus = new EventBus();
const streaming = new StreamingPipeline();

// Wire event bus to streaming pipeline
streaming.attachToEventBus(eventBus);
```

**Register streaming handlers for real-time output:**
```typescript
streaming.onMessageDelta((event) => {
  // Print token-by-token as it arrives
  process.stdout.write(event.content);
});

streaming.onReasoningDelta((event) => {
  // Show model reasoning in real-time
  console.log(`[💭 ${event.agentName} thinks]\n${event.content}`);
});

streaming.onUsage((event) => {
  // Track cost in real-time
  console.log(`[📊 ${event.agentName}] ${event.inputTokens} in, ${event.outputTokens} out — $${event.estimatedCost.toFixed(4)}`);
});
```

**Route message to correct agent and create session:**
```typescript
const message = 'How do I optimize database queries?';

// Router determines which agent should handle this
const route = router.matchRoute(message);
// → { agent: 'Backend', priority: 'normal' }

const session = await client.createSession({
  agentName: route.agent,
  task: message,
  persistPath: `.squad/sessions/${route.agent}-${Date.now()}.json`,
});

// Attach session to streaming pipeline
streaming.attachSession(session.sessionId);

// Send message — responses stream via handlers
await session.sendMessage(message);
```

**Interactive loop — user types, agents respond:**
```typescript
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const askUser = () => {
  rl.question('You: ', async (input) => {
    const route = router.matchRoute(input);
    const session = await client.createSession({
      agentName: route.agent,
      task: input,
    });
    streaming.attachSession(session.sessionId);
    
    console.log(`\n[${route.agent}]: `);
    await session.sendMessage(input);
    console.log('\n');
    
    askUser();
  });
};

askUser();
```

## User Experience

1. User runs `npm start` (or opens web/CLI interface)
2. Prompt appears: "You: "
3. User types: "How should we handle user auth?"
4. SDK routes message to 'Backend' agent
5. Backend's response streams token-by-token:
   ```
   [Backend]: 
   We should implement JWT tokens with...
   refresh token rotation for security...
   ```
6. Reasoning deltas appear if model is thinking:
   ```
   [💭 Backend thinks]
   The user is asking about auth architecture.
   I should consider: token lifecycle, refresh strategy, revocation...
   ```
7. Usage summary at end of response:
   ```
   [📊 Backend] 245 in, 187 out — $0.0045
   ```
8. Loop back to "You: " prompt

## Acceptance Criteria

1. ✅ User can type messages interactively
2. ✅ Router correctly identifies target agent for each message
3. ✅ Sessions persist (can resume if interrupted)
4. ✅ Message deltas stream in real-time (token-by-token)
5. ✅ Reasoning deltas display when model is thinking
6. ✅ Usage events track tokens and cost per agent
7. ✅ Multiple agents can participate in same conversation
8. ✅ EventBus propagates events across all listeners
9. ✅ Sample is ~300 lines (excluding dependencies)

## Test Script

```bash
# Navigate to samples/streaming-chat
npm install

# Run interactive chat
npm start

# Test sequence:
# You: What's the difference between REST and GraphQL?
# [Backend]: (response streams token-by-token)
# [💭 Backend thinks] (reasoning appears mid-stream)
# [📊 Backend] (usage summary at end)
# 
# You: Can you explain that more simply?
# [Backend]: (second response streams)
#
# You: exit
# (session persists; verify .squad/sessions/ has new files)

# Run test suite
npm test

# Expected tests:
# PASS: Router matches messages to correct agent
# PASS: StreamingPipeline captures message deltas
# PASS: ReasoningDelta events fire when model thinks
# PASS: UsageEvent aggregates cost correctly
# PASS: EventBus publishes to all attached listeners
# PASS: Session persists and can be resumed
```
