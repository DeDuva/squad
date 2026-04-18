# Autonomous Pipeline — SDK Sample PRD

## Overview
The "wow" demo. A live terminal dashboard shows agents working autonomously: routing tasks, making decisions, recording telemetry, managing cost. No human prompting. Work flows through the pipeline—task queue → router → agent selection → execution → decision log → cost report. Full SDK stack in action.

## Target Audience
Executives, investors, and engineering leaders who need to see Squad in action. "Here's how autonomous agent teams actually work." Proof that coordination and governance work at scale.

## SDK APIs Demonstrated

| API | Module | What It Shows |
|-----|--------|--------------|
| `CastingEngine.castTeam()` | `casting` | Assign agent personas from universe |
| `SquadClient` / `SessionPool` | `client` | Manage persistent, recoverable agent sessions |
| `Router.matchRoute()` | `coordinator` | Deterministic task routing |
| `HookPipeline` | `hooks` | Governance enforcement at execution time |
| `StreamingPipeline` | `runtime/streaming` | Real-time event handlers for deltas/usage |
| `CostTracker` | `runtime/cost-tracker` | Accumulate cost/token data per agent |
| `TelemetryCollector` | `runtime/telemetry` | Record metrics: task count, decision count, error count |
| `EventBus` | `runtime/event-bus` | Pub/sub for agent:task-start, agent:task-complete, agent:error, decision:created events |
| `squad_route`, `squad_decide`, `squad_memory` | `tools` | Inter-agent coordination tools |
| `ToolRegistry` | `tools` | Register custom and built-in tools |

## Code Highlights

**Bootstrap the full pipeline:**
```typescript
import {
  resolveSquad,
  loadConfig,
  CastingEngine,
  SquadClient,
  SessionPool,
  HookPipeline,
  StreamingPipeline,
  CostTracker,
  TelemetryCollector,
  EventBus,
  ToolRegistry,
  Router,
} from '@squad/sdk';

const squadPath = resolveSquad();
const config = loadConfig(squadPath);

// Cast the team
const casting = new CastingEngine({ universe: 'usual-suspects', agentCount: 5 });
const cast = casting.castTeam({ 
  roles: ['lead', 'frontend', 'backend', 'tester', 'scribe'] 
});

// Create execution pipeline
const client = new SquadClient({ squadPath });
const pool = new SessionPool({ capacity: 10 });
const pipeline = new HookPipeline({
  allowedWritePaths: ['src/**', '.squad/**', 'docs/**'],
  maxAskUserPerSession: 3,
  scrubPii: true,
});
const streaming = new StreamingPipeline();
const costTracker = new CostTracker();
const telemetry = new TelemetryCollector();
const eventBus = new EventBus();
const router = new Router({ config });
const tools = new ToolRegistry();

// Wire everything together
streaming.attachToEventBus(eventBus);
costTracker.attachToEventBus(eventBus);
telemetry.attachToEventBus(eventBus);

console.log('✅ Pipeline initialized');
console.log(`   Cast: ${cast.map(c => c.agentName).join(', ')}`);
console.log(`   Budget: $${config.budget}`);
```

**Task queue and routing loop:**
```typescript
interface WorkItem {
  id: string;
  description: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  createdAt: Date;
}

const queue: WorkItem[] = [
  { id: 'task-001', description: 'Design API schema', priority: 'high', createdAt: new Date() },
  { id: 'task-002', description: 'Fix typo in README', priority: 'low', createdAt: new Date() },
  { id: 'task-003', description: 'Implement auth flow', priority: 'critical', createdAt: new Date() },
  { id: 'task-004', description: 'Write unit tests', priority: 'normal', createdAt: new Date() },
];

// Sort by priority (critical first, then high, normal, low)
queue.sort((a, b) => {
  const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
  return priorityOrder[a.priority] - priorityOrder[b.priority];
});

console.log('\n📋 Work Queue:');
queue.forEach((item, idx) => {
  const priorityEmoji = {
    critical: '🔴',
    high: '🟠',
    normal: '🟡',
    low: '🟢',
  };
  console.log(`  ${idx + 1}. [${priorityEmoji[item.priority]}] ${item.description}`);
});

// Process queue
for (const item of queue) {
  const route = router.matchRoute(item.description);
  const castMember = cast.find(c => c.role === route.role);

  // Create agent session
  const session = await pool.acquire();
  session.setAgent(castMember.agentName);

  // Record event
  eventBus.publish({
    type: 'agent:task-start',
    agentName: castMember.agentName,
    taskId: item.id,
    taskDescription: item.description,
    timestamp: new Date(),
  });

  console.log(`\n▶️  ${castMember.agentName} starting: ${item.description}`);

  // Execute with hooks and streaming
  try {
    const response = await session.sendMessage(item.description);
    
    eventBus.publish({
      type: 'agent:task-complete',
      agentName: castMember.agentName,
      taskId: item.id,
      timestamp: new Date(),
    });

    console.log(`✅ ${castMember.agentName} completed task-${item.id}`);
  } catch (error) {
    eventBus.publish({
      type: 'agent:error',
      agentName: castMember.agentName,
      taskId: item.id,
      error: (error as Error).message,
      timestamp: new Date(),
    });

    console.log(`❌ ${castMember.agentName} failed on task-${item.id}`);
  }

  pool.release(session);
}
```

**Decision recording (agents document their choices):**
```typescript
// Simulate decision recording by agents
const decisions = [
  {
    author: 'Backend',
    summary: 'Use PostgreSQL with JSONB, not MongoDB',
    body: 'Chose PostgreSQL for: (1) ACID transactions, (2) team expertise, (3) JSONB for flexible schema.',
    references: ['task-001', 'architecture-review'],
  },
  {
    author: 'Frontend',
    summary: 'Adopt Tailwind v4 with dark mode',
    body: 'Reasoning: utility-first CSS, dark mode support built-in, smaller bundle than Material UI.',
    references: ['design-system'],
  },
];

for (const decision of decisions) {
  await tools.getTool('squad_decide').handler({
    author: decision.author,
    summary: decision.summary,
    body: decision.body,
    references: decision.references,
  });

  eventBus.publish({
    type: 'decision:created',
    author: decision.author,
    summary: decision.summary,
    timestamp: new Date(),
  });

  console.log(`📝 Decision recorded by ${decision.author}: "${decision.summary}"`);
}
```

**Live dashboard with real-time metrics:**
```typescript
function renderDashboard() {
  console.clear();
  console.log('┌─────────────────────────────────────────┐');
  console.log('│  SQUAD AUTONOMOUS PIPELINE DASHBOARD    │');
  console.log('└─────────────────────────────────────────┘\n');

  const summary = costTracker.getSummary();
  const telemetrySummary = telemetry.getSummary();

  // Team status
  console.log('👥 Team:');
  cast.forEach(member => {
    const agentStats = summary.agents.get(member.agentName);
    const taskCount = agentStats?.turnCount ?? 0;
    const cost = agentStats?.estimatedCost ?? 0;
    console.log(`   ${member.agentName.padEnd(12)} ${taskCount} tasks  $${cost.toFixed(4)}`);
  });

  // Cost summary
  console.log('\n💰 Cost Tracking:');
  console.log(`   Total Spend: $${summary.totalEstimatedCost.toFixed(2)}`);
  console.log(`   Budget Used: ${((summary.totalEstimatedCost / config.budget) * 100).toFixed(1)}%`);
  console.log(`   Tokens: ${summary.totalInputTokens + summary.totalOutputTokens}`);

  // Metrics
  console.log('\n📊 Metrics:');
  console.log(`   Tasks Started:    ${telemetrySummary.tasksStarted}`);
  console.log(`   Tasks Completed:  ${telemetrySummary.tasksCompleted}`);
  console.log(`   Errors:           ${telemetrySummary.errorCount}`);
  console.log(`   Decisions Made:   ${telemetrySummary.decisionsCreated}`);

  // Recent events (last 5)
  console.log('\n📜 Recent Events:');
  const recentEvents = telemetry.getRecentEvents(5);
  recentEvents.forEach(event => {
    console.log(`   ${event.timestamp.toLocaleTimeString()} ${event.type}`);
  });

  console.log('\n' + '─'.repeat(45));
  console.log(`Updated at: ${new Date().toLocaleTimeString()}`);
}

// Update dashboard every 2 seconds
setInterval(renderDashboard, 2000);
```

## User Experience

1. User runs `npm start`
2. SDK initializes full pipeline (casting, router, hooks, telemetry, cost tracker)
3. Dashboard renders in terminal:
   ```
   ┌─────────────────────────────────────────┐
   │  SQUAD AUTONOMOUS PIPELINE DASHBOARD    │
   └─────────────────────────────────────────┘

   👥 Team:
      Keaton       3 tasks  $0.0045
      McManus      2 tasks  $0.0012
      Verbal       4 tasks  $0.0089
      Fenster      1 task   $0.0003
      Kobayashi    1 task   $0.0001

   💰 Cost Tracking:
      Total Spend: $0.0150
      Budget Used: 0.02%
      Tokens: 4,320

   📊 Metrics:
      Tasks Started:    11
      Tasks Completed:  10
      Errors:           1
      Decisions Made:   3

   📜 Recent Events:
      14:35:22 agent:task-complete
      14:35:18 decision:created
      14:35:15 agent:task-start
      14:35:10 agent:task-complete
      14:35:05 agent:error

   ─────────────────────────────────────────
   Updated at: 14:35:25
   ```
4. Watch agents work through queue in real-time
5. Decisions appear as they're recorded
6. Cost updates in real-time
7. Dashboard refreshes continuously (2 sec interval)
8. Press `q` to stop and view final report

## Acceptance Criteria

1. ✅ Team cast displays with agent names
2. ✅ Task queue displayed sorted by priority
3. ✅ Router deterministically assigns tasks to agents
4. ✅ Sessions managed in pool (acquire/release)
5. ✅ HookPipeline enforces governance on tool execution
6. ✅ StreamingPipeline captures message/reasoning/usage events
7. ✅ CostTracker aggregates cost per agent and per session
8. ✅ TelemetryCollector tracks task count, decision count, error count
9. ✅ EventBus publishes agent:task-start, agent:task-complete, agent:error, decision:created
10. ✅ Live dashboard updates every 2 seconds with current metrics
11. ✅ Final report shows cost breakdown and savings analysis
12. ✅ Sample is ~500 lines (excluding dependencies)

## Test Script

```bash
# Navigate to samples/autonomous-pipeline
npm install

# Run the autonomous pipeline demo
npm start

# Watch the dashboard update every 2 seconds
# Should see:
# - Team members listed with task counts and costs
# - Tasks being processed from queue
# - Decisions being recorded
# - Cost accumulating in real-time
# - Metrics updating (tasks completed, errors, etc.)

# Example output progression:
# Initial: Tasks Started: 0, Tasks Completed: 0
# After 5s: Tasks Started: 5, Tasks Completed: 2
# After 10s: Tasks Started: 11, Tasks Completed: 10
# After 20s: Tasks Started: 11, Tasks Completed: 11

# Press 'q' to stop and view final report:
# 💰 Final Cost Report
# Total: $0.0150
# Budget Used: 0.02%
# By Agent: [breakdown table]

# Run test suite
npm test

# Expected tests:
# PASS: CastingEngine creates team with unique names
# PASS: Router matches tasks to agents deterministically
# PASS: HookPipeline enforces file-write guardrails
# PASS: StreamingPipeline captures all event types
# PASS: CostTracker aggregates usage correctly
# PASS: TelemetryCollector tracks metrics accurately
# PASS: EventBus publishes events to all subscribers
# PASS: SessionPool manage acquire/release lifecycle
# PASS: Dashboard renders without errors
# PASS: Final report shows cost breakdown and savings
```
