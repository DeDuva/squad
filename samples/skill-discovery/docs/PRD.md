# Skill Discovery — SDK Sample PRD

## Overview
Agents that learn. Demonstrate the skill lifecycle: create a skill definition, load skills from disk, match them to tasks, and watch confidence grow as agents use them. Low confidence → Medium → High. This shows how Squad encodes domain knowledge in code, not prompts.

## Target Audience
Teams building evolving AI agents. Anyone needing transparent, auditable learning — track which skills were matched, at what confidence, and how confidence changed over time.

## SDK APIs Demonstrated

| API | Module | What It Shows |
|-----|--------|--------------|
| `SkillRegistry` | `skills` | Register and lookup skills by ID |
| `loadSkillsFromDirectory()` | `skills/skill-loader` | Load SKILL.md files into the registry |
| `parseSkillFile()` | `skills/skill-loader` | Parse frontmatter + body of a skill definition |
| `matchSkills()` | `skills` | Score and rank skills by task relevance |
| `SkillDefinition` | `skills` | Typed skill with id, triggers, agentRoles, body, confidence |
| Confidence lifecycle | `skills` | Low (0.0–0.4) → Medium (0.4–0.7) → High (0.7–1.0) |

## Code Highlights

**Define a skill (SKILL.md file):**
```yaml
---
id: oauth2-pkce
title: OAuth2 PKCE Flow Implementation
agentRoles:
  - backend
  - security
triggers:
  - oauth
  - authentication
  - pkce
  - mobile
confidence: 0.5
---

## Overview
Implement OAuth2 Authorization Code Flow with PKCE for secure mobile/SPA authentication.

## When to Use
- Mobile apps where storing secrets is unsafe
- Single-Page Apps (React, Vue, etc.)
- Third-party integrations needing user consent

## Implementation Steps
1. Generate code_challenge from code_verifier
2. Redirect user to authorization endpoint with code_challenge
3. Receive authorization code
4. Exchange code + code_verifier for token (no client secret)
5. Store token securely

## Code Example
```typescript
const codeVerifier = generateRandomString(128);
const codeChallenge = base64url(sha256(codeVerifier));

const authUrl = new URL('https://auth-server.com/authorize');
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');
// ... redirect user
```

## Common Pitfalls
- Storing code_verifier in localStorage (vulnerable to XSS)
- Using code_challenge_method = 'plain' (defeats PKCE purpose)
- Not validating state parameter (vulnerable to CSRF)
```

**Initialize skill registry and load skills from disk:**
```typescript
import { 
  SkillRegistry, 
  loadSkillsFromDirectory,
  parseSkillFile 
} from '@squad/sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';

const registry = new SkillRegistry();
const skillsDir = '.squad/skills';

// Load all SKILL.md files
const skills = await loadSkillsFromDirectory(skillsDir);
skills.forEach(skill => registry.registerSkill(skill));

console.log(`📚 Loaded ${registry.size} skills`);
registry.getAllSkills().forEach(s => {
  console.log(`  - ${s.id} (${s.agentRoles.join('/')})`);
});
```

**Match skills to a task and display scores:**
```typescript
const task = 'Implement OAuth2 PKCE flow for React app';
const agentRole = 'backend';

const matches = registry.matchSkills(task, agentRole);

console.log(`\n🔍 Matching skills for: "${task}"`);
console.log(`   Agent role: ${agentRole}\n`);

matches.forEach((match, idx) => {
  const confidenceBar = '█'.repeat(Math.round(match.score * 10));
  const confidenceLevel = 
    match.skill.confidence < 0.4 ? '🔴 Low' :
    match.skill.confidence < 0.7 ? '🟡 Medium' :
    '🟢 High';

  console.log(`${idx + 1}. ${match.skill.id}`);
  console.log(`   Score: ${(match.score * 100).toFixed(1)}% [${confidenceBar}]`);
  console.log(`   Confidence: ${confidenceLevel} (${match.skill.confidence})`);
  console.log(`   Triggers matched: ${match.reason}`);
  console.log();
});

// Top match
if (matches.length > 0) {
  console.log(`✨ Top skill: ${matches[0].skill.id}`);
  console.log(`   Inject this into agent context before task execution`);
}
```

**Use matched skills in agent session (inject into context):**
```typescript
const session = await client.createSession({
  agentName: 'Backend',
  task: 'Implement OAuth2 PKCE flow for React app',
});

// Inject matched skills into agent charter
const matches = registry.matchSkills(session.task, 'backend');
const skillContext = matches
  .map(m => `## Skill: ${m.skill.title}\n${m.skill.body}`)
  .join('\n\n');

const enhancedCharter = `
${session.charter}

## Domain Skills (Matched to this task)
${skillContext}
`;

session.setContext(enhancedCharter);

// Now agent has skill details available
const response = await session.sendMessage('Implement OAuth2 PKCE');
```

**Track skill confidence over time:**
```typescript
// Simple in-memory confidence tracker
const skillConfidenceHistory = new Map();

async function executeTaskWithSkills(taskDesc) {
  const matches = registry.matchSkills(taskDesc, 'backend');
  
  for (const match of matches) {
    const skillId = match.skill.id;
    
    // Record skill use at current confidence
    if (!skillConfidenceHistory.has(skillId)) {
      skillConfidenceHistory.set(skillId, []);
    }
    skillConfidenceHistory.get(skillId).push({
      taskId: `task-${Date.now()}`,
      matchScore: match.score,
      skillConfidence: match.skill.confidence,
      timestamp: new Date(),
    });

    // After successful execution, confidence increases
    match.skill.confidence = Math.min(1.0, match.skill.confidence + 0.1);
    console.log(`📈 ${skillId}: confidence bumped to ${match.skill.confidence.toFixed(2)}`);
  }
}

// Simulate multiple tasks
await executeTaskWithSkills('Implement OAuth2 PKCE flow');
await executeTaskWithSkills('Add PKCE validation to API gateway');
await executeTaskWithSkills('Test PKCE edge cases');

// Show confidence progression
console.log('\n📊 Skill Confidence Over Time:');
for (const [skillId, history] of skillConfidenceHistory.entries()) {
  console.log(`\n${skillId}:`);
  history.forEach((h, i) => {
    console.log(`  Task ${i + 1}: score=${(h.matchScore * 100).toFixed(0)}%, confidence=${(h.skillConfidence).toFixed(2)}`);
  });
}
```

## User Experience

1. Squad loads skill library from `.squad/skills/` directory
2. User submits task: "Implement OAuth2 PKCE for React"
3. SDK matches task to skills using trigger keywords and role affinity
4. Terminal displays ranked matches:
   ```
   🔍 Matching skills for: "Implement OAuth2 PKCE for React"
      Agent role: backend

   1. oauth2-pkce
      Score: 85.0% [████████░]
      Confidence: 🟡 Medium (0.5)
      Triggers matched: oauth, authentication, pkce
   
   2. react-integration
      Score: 62.5% [██████░░░]
      Confidence: 🟢 High (0.8)
      Triggers matched: react
   
   ✨ Top skill: oauth2-pkce
      Inject this into agent context before task execution
   ```
5. Matched skills injected into agent's context
6. After successful execution, skill confidence increases: 0.5 → 0.6
7. Next time same skill matches, it shows higher confidence

## Acceptance Criteria

1. ✅ Skills load from SKILL.md files with frontmatter
2. ✅ `matchSkills()` scores based on trigger keywords
3. ✅ `matchSkills()` factors in agent role affinity
4. ✅ Scores range from 0.0 to 1.0 (clamped)
5. ✅ Confidence levels show as Low (< 0.4), Medium (0.4–0.7), High (> 0.7)
6. ✅ Matched skills can be injected into agent context
7. ✅ Confidence increases after successful skill usage
8. ✅ Confidence history tracks progression over time
9. ✅ Sample is ~300 lines (excluding dependencies)

## Test Script

```bash
# Navigate to samples/skill-discovery
npm install

# Create sample skills in .squad/skills/
mkdir -p .squad/skills

# Add sample SKILL.md files
cat > .squad/skills/oauth2-pkce.md << 'EOF'
---
id: oauth2-pkce
title: OAuth2 PKCE Implementation
agentRoles:
  - backend
  - security
triggers:
  - oauth
  - pkce
  - authentication
confidence: 0.5
---

Implementation guide for OAuth2 PKCE flow...
EOF

# Run skill discovery demo
npm start

# Expected output:
# 📚 Loaded 1 skill
#   - oauth2-pkce (backend/security)
#
# 🔍 Matching skills for: "Implement OAuth2 PKCE for React"
#    Agent role: backend
#
# 1. oauth2-pkce
#    Score: 85.0% [████████░]
#    Confidence: 🟡 Medium (0.5)
#    Triggers matched: oauth, pkce, authentication

# Run test suite
npm test

# Expected tests:
# PASS: loadSkillsFromDirectory reads SKILL.md files
# PASS: parseSkillFile extracts frontmatter correctly
# PASS: matchSkills scores trigger keywords
# PASS: matchSkills factors in agent role affinity
# PASS: Confidence increases after skill usage
# PASS: Confidence history tracks progression
```
