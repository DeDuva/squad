/**
 * Type extension tests — Issues #222 and #223 (Epic #181)
 *
 * Tests for ParsedDecision (+date, +author, +headingLevel) and
 * ParsedAgent (+aliases, +autoAssign) optional fields.
 */

import { describe, it, expect } from 'vitest';

import {
  parseTeamMarkdown,
  parseDecisionsMarkdown,
} from '@deduvafork/squad-sdk/config';

// ===========================================================================
// ParsedDecision extensions (#222) — 8 tests
// ===========================================================================

describe('ParsedDecision: date field', () => {
  it('extracts ISO date from heading like "### 2026-02-21: Title"', () => {
    const md = `
### 2026-02-21: Use strict mode
Strict mode is non-negotiable.
`;
    const { decisions } = parseDecisionsMarkdown(md);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.date).toBe('2026-02-21');
    expect(decisions[0]!.title).toBe('Use strict mode');
  });

  it('date is undefined when heading has no date prefix', () => {
    const md = `
## Plain title
Body content here.
`;
    const { decisions } = parseDecisionsMarkdown(md);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.date).toBeUndefined();
  });
});

describe('ParsedDecision: author field', () => {
  it('extracts author from **By:** line in body', () => {
    const md = `
### Some Decision
**By:** Keaton
This decision sets the model tier.
`;
    const { decisions } = parseDecisionsMarkdown(md);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.author).toBe('Keaton');
  });

  it('author is undefined when no **By:** line present', () => {
    const md = `
## Decision without author
Just body text.
`;
    const { decisions } = parseDecisionsMarkdown(md);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.author).toBeUndefined();
  });
});

describe('ParsedDecision: headingLevel field', () => {
  it('returns 2 for H2 headings', () => {
    const md = `
## H2 Decision
Body.
`;
    const { decisions } = parseDecisionsMarkdown(md);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.headingLevel).toBe(2);
  });

  it('returns 3 for H3 headings', () => {
    const md = `
### H3 Decision
Body.
`;
    const { decisions } = parseDecisionsMarkdown(md);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.headingLevel).toBe(3);
  });
});

describe('ParsedDecision: combined new fields', () => {
  it('extracts date, author, and headingLevel together', () => {
    const md = `
### 2026-02-21: SDK distribution stays on GitHub
**By:** Keaton (carried from beta)
**What:** Distribution is npx — never move to npmjs.com.
`;
    const { decisions } = parseDecisionsMarkdown(md);
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d.date).toBe('2026-02-21');
    expect(d.author).toBe('Keaton (carried from beta)');
    expect(d.headingLevel).toBe(3);
    expect(d.title).toBe('SDK distribution stays on GitHub');
  });

  it('all new fields absent when not present in markdown', () => {
    const md = `
## Bare Heading
No special metadata here.
`;
    const { decisions } = parseDecisionsMarkdown(md);
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d.date).toBeUndefined();
    expect(d.author).toBeUndefined();
    expect(d.headingLevel).toBe(2);
    expect(d.title).toBe('Bare Heading');
  });
});

// ===========================================================================
// ParsedAgent extensions (#223) — 6 tests
// ===========================================================================

describe('ParsedAgent: aliases field (section format)', () => {
  it('parses aliases from section key-value line', () => {
    const md = `
## Roster

### Edie
- **Role:** TypeScript Engineer
- **Skills:** typescript, strict-mode
- **Aliases:** ts-lead, type-master
`;
    const { agents } = parseTeamMarkdown(md);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.aliases).toEqual(['ts-lead', 'type-master']);
  });

  it('aliases is undefined when not specified', () => {
    const md = `
## Roster

### Fenster
- **Role:** Core Dev
- **Skills:** typescript
`;
    const { agents } = parseTeamMarkdown(md);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.aliases).toBeUndefined();
  });
});

describe('ParsedAgent: aliases field (table format)', () => {
  it('parses aliases from table column', () => {
    const md = `
## Roster

| Name | Role | Skills | Aliases |
|------|------|--------|---------|
| Edie | TS Engineer | typescript | ts-lead, type-master |
`;
    const { agents } = parseTeamMarkdown(md);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.aliases).toEqual(['ts-lead', 'type-master']);
  });
});

describe('ParsedAgent: autoAssign field', () => {
  it('parses auto-assign: yes as true (section format)', () => {
    const md = `
## Roster

### Hockney
- **Role:** Tester
- **Skills:** testing
- **Auto-assign:** yes
`;
    const { agents } = parseTeamMarkdown(md);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.autoAssign).toBe(true);
  });

  it('parses auto-assign: no as false (section format)', () => {
    const md = `
## Roster

### Baer
- **Role:** Security
- **Skills:** hooks
- **Auto-assign:** no
`;
    const { agents } = parseTeamMarkdown(md);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.autoAssign).toBe(false);
  });

  it('autoAssign is undefined when not specified', () => {
    const md = `
## Roster

### Fenster
- **Role:** Core Dev
- **Skills:** typescript
`;
    const { agents } = parseTeamMarkdown(md);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.autoAssign).toBeUndefined();
  });
});
