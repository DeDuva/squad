# Hello Squad — SDK Sample PRD

## Overview
The simplest possible Squad SDK sample. Create a team, cast agents from a thematic universe, initialize their sessions, and display the roster. This is the "hello world" — shows that the casting engine works and teams persist as typed objects.

## Target Audience
Developers new to Squad. No async patterns, no tooling, no governance. Pure SDK mechanics: resolve config, cast a team, print the roster.

## SDK APIs Demonstrated

| API | Module | What It Shows |
|-----|--------|--------------|
| `resolveSquad()` | `resolution` | Locate the `.squad/` directory from the current working directory |
| `loadConfig()` | `config` | Parse `squad.yaml` into a typed configuration object |
| `CastingEngine.castTeam()` | `casting` | Assign agent names from a universe theme; create `CastMember[]` |
| `onboardAgent()` | `agents` | Register an agent and create its persistent session |
| Config types | `config` | `SquadConfig`, `AgentDefinition`, `UniverseId` |

## Code Highlights

**Initial setup — resolve and load:**
```typescript
import { resolveSquad, loadConfig, CastingEngine, onboardAgent } from '@squad/sdk';

const squadPath = resolveSquad();
const config = loadConfig(squadPath);
```

**Cast the team from a universe:**
```typescript
const casting = new CastingEngine({
  universe: 'usual-suspects',
  agentCount: config.agents.length,
});

const cast = casting.castTeam({
  roles: config.agents.map(a => a.role),
});
// → [
//   { role: 'lead', agentName: 'Keaton' },
//   { role: 'frontend', agentName: 'McManus' },
//   { role: 'backend', agentName: 'Verbal' },
//   ...
// ]
```

**Onboard each agent and build the roster:**
```typescript
const roster = [];
for (const member of cast) {
  const agent = config.agents.find(a => a.role === member.role);
  const session = await onboardAgent({
    agentName: member.agentName,
    role: member.role,
    squadPath,
  });
  roster.push({ ...member, session });
}

console.log('🎭 Team Roster:');
roster.forEach(m => {
  console.log(`  ${m.agentName} — ${m.role}`);
});
```

## User Experience

1. User runs `npm start`
2. SDK resolves `.squad/` from cwd
3. SDK loads `squad.yaml` 
4. Casting engine assigns agent names from universe theme
5. Each agent gets a session with persistent identity
6. Terminal prints a clean roster:
   ```
   🎭 Team Roster:
     Keaton — lead
     McManus — frontend
     Verbal — backend
     Fenster — tester
     Kobayashi — scribe
   ```

## Acceptance Criteria

1. ✅ `npm start` runs without errors
2. ✅ Casting engine produces consistent names across runs (same universe)
3. ✅ Each agent has a unique session object with agentName, role, and sessionId
4. ✅ Roster displays all agents from config
5. ✅ Sample is ~100 lines (excluding dependencies)

## Test Script

```bash
# Clone squad and navigate to samples/hello-squad
npm install

# Run the sample
npm start

# Expected output:
# 🎭 Team Roster:
#   Keaton — lead
#   McManus — frontend
#   Verbal — backend
#   ...

# Verify casting is deterministic
npm start
# Should produce same names
```
