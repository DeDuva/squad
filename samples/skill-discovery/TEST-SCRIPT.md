# Skill Discovery — Test Script

Manual verification steps for the skill-discovery sample.

## Pre-requisites

- [ ] Node.js ≥ 20 installed
- [ ] Dependencies installed: `npm install` from repo root
- [ ] SDK built: `npm run build` from repo root

## Test 1: Demo Runs Without Errors

```bash
npx tsx samples/skill-discovery/index.ts
```

**Expected:**
- [ ] Output starts with `═══` heading: "Skill Discovery Demo"
- [ ] Step 1 shows 3 loaded skills with confidence icons (🔴, 🟡, 🟢)
- [ ] Step 2 confirms 3 skills registered
- [ ] Step 3 shows match results for 4 different tasks
- [ ] Step 4 shows a new "Error Handling Patterns" skill discovered
- [ ] Step 5 shows the new skill matching an error-related task
- [ ] Step 6 shows the confidence lifecycle explanation
- [ ] Output ends with "Demo Complete" and cleanup message
- [ ] No errors or stack traces

## Test 2: Cleanup Verification

After the demo runs:

```bash
# The temp directory printed in the output should not exist
# Check the path from "Cleaned up temporary directory: ..."
```

**Expected:**
- [ ] Temp directory is removed after demo completes
- [ ] No leftover `.squad/skills/` directories in temp

## Test 3: Automated Tests Pass

```bash
npx vitest run samples/skill-discovery/tests/skill-discovery.test.ts
```

**Expected:**
- [ ] All tests pass (0 failures)
- [ ] Test suites: parseFrontmatter, parseSkillFile, loadSkillsFromDirectory, SkillRegistry, matchSkills, confidence lifecycle, end-to-end
- [ ] No temp files left behind (afterEach cleanup)

## Test 4: Match Scoring Sanity

During demo output, verify:

- [ ] "Add TypeScript generics to the data layer" → TypeScript Patterns matches (triggers: typescript, generics)
- [ ] "Design a REST API endpoint" → API Design matches (triggers: api, rest, endpoint)
- [ ] "Write vitest coverage tests" → Testing Best Practices matches (triggers: vitest, coverage, test)
- [ ] Cross-domain task matches multiple skills with lead role getting role affinity boost

## Test 5: Edge Case — Empty Directory

In a Node.js REPL or script:

```typescript
import { loadSkillsFromDirectory } from '@squad/sdk/skills';
const skills = loadSkillsFromDirectory('/nonexistent/path');
console.log(skills); // Should be []
```

**Expected:**
- [ ] Returns empty array, no error thrown
