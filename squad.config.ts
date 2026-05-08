import {
  defineSquad,
  defineTeam,
  defineAgent,
  defineRouting,
  defineCasting,
} from '@deduvafork/squad-sdk';

/**
 * Squad Configuration — squad-sdk
 *
 * Converted from .squad/ markdown to SDK-first builder syntax.
 * Run `squad build` to regenerate .squad/*.md from this file.
 */
export default defineSquad({
  version: '1.0.0',

  team: defineTeam({
    name: 'squad-sdk',
    description: 'The programmable multi-agent runtime powered by Gemini (airgap fork).',
    projectContext:
      '- **Fork:** DeDuva/squad — Gemini replatform, airgap/build-from-source mode\n' +
      '- **Stack:** TypeScript (strict mode, ESM-only), Node.js ≥22, @google/generative-ai (Gemini), Vitest, esbuild\n' +
      '- **Description:** Multi-agent runtime replatformed from GitHub Copilot to Gemini API — airlock mode, no binary downloads\n' +
      '- **Distribution:** build from source (`npm run build`) or npm (`npm install -g @deduvafork/squad-cli` / `npm install @deduvafork/squad-sdk`)\n' +
      '- **Created:** 2026-02-21',
    members: [
      'keaton', 'verbal', 'fenster', 'hockney', 'mcmanus', 'kujan',
      'edie', 'kobayashi', 'fortier', 'rabin', 'baer', 'redfoot',
      'strausz', 'saul', 'kovash', 'marquez', 'cheritto', 'breedan',
      'nate', 'waingro',
    ],
  }),

  agents: [
    defineAgent({ name: 'keaton', role: 'Lead', description: 'Architect, scope-holder, the one who sees the whole board.', status: 'active' }),
    defineAgent({ name: 'verbal', role: 'Prompt Engineer', description: 'Crafts prompts, charters, and coordinator logic.', status: 'active' }),
    defineAgent({ name: 'fenster', role: 'Core Dev', description: 'Practical, thorough, makes it work then makes it right.', status: 'active' }),
    defineAgent({ name: 'hockney', role: 'Tester', description: 'If it is not tested, it does not work.', status: 'active' }),
    defineAgent({ name: 'mcmanus', role: 'DevRel', description: 'Docs, messaging, developer experience.', status: 'active' }),
    defineAgent({ name: 'kujan', role: 'SDK Expert', description: 'The one who understands the Gemini SDK and squad-sdk adapter inside and out.', status: 'active' }),
    defineAgent({ name: 'edie', role: 'TypeScript Engineer', description: 'Precise, type-obsessed. Types are contracts. If it compiles, it works.', status: 'active' }),
    defineAgent({ name: 'kobayashi', role: 'Git & Release', description: 'Semantic versioning, releases, branch protection.', status: 'active' }),
    defineAgent({ name: 'fortier', role: 'Node.js Runtime', description: 'Streaming, event loop health, async iterators, memory profiling.', status: 'active' }),
    defineAgent({ name: 'rabin', role: 'Distribution', description: 'npm packaging, esbuild config, global install, marketplace.', status: 'active' }),
    defineAgent({ name: 'baer', role: 'Security', description: 'Hook design, PII filters, file-write guards, compliance.', status: 'active' }),
    defineAgent({ name: 'redfoot', role: 'Graphic Designer', description: 'Logo, icons, brand assets, design system.', status: 'active' }),
    defineAgent({ name: 'strausz', role: 'VS Code Extension', description: 'VS Code Extension API, runSubagent, editor integration.', status: 'active' }),
    defineAgent({ name: 'saul', role: 'Aspire & Observability', description: 'Aspire dashboard, OTLP integration, Docker telemetry.', status: 'active' }),
    defineAgent({ name: 'kovash', role: 'REPL & Interactive Shell', description: 'Interactive shell, Ink components, session dispatch.', status: 'active' }),
    defineAgent({ name: 'marquez', role: 'CLI UX Designer', description: 'Interaction design, copy, spacing, affordances, UX gates.', status: 'active' }),
    defineAgent({ name: 'cheritto', role: 'TUI Engineer', description: 'Ink components, layout, input handling, rendering perf.', status: 'active' }),
    defineAgent({ name: 'breedan', role: 'E2E Test Engineer', description: 'node-pty harness, Gherkin features, frame snapshots.', status: 'active' }),
    defineAgent({ name: 'nate', role: 'Accessibility Reviewer', description: 'Keyboard nav, color contrast, error guidance, shortcut discoverability.', status: 'active' }),
    defineAgent({ name: 'waingro', role: 'Product Dogfooder', description: 'Adversarial testing, edge cases, regression scenarios.', status: 'active' }),
  ],

  routing: defineRouting({
    rules: [
      { pattern: 'core-runtime', agents: ['@fenster'], description: 'GeminiClient, adapter, session pool, tools module, spawn orchestration' },
      { pattern: 'prompt-architecture', agents: ['@verbal'], description: 'Agent charters, spawn templates, coordinator logic, response tier selection' },
      { pattern: 'type-system', agents: ['@edie'], description: 'Discriminated unions, generics, tsconfig, strict mode, declaration files' },
      { pattern: 'sdk-integration', agents: ['@kujan'], description: '@google/generative-ai usage, GeminiSession lifecycle, event handling' },
      { pattern: 'runtime-performance', agents: ['@fortier'], description: 'Streaming, event loop health, session management, async iterators' },
      { pattern: 'testing', agents: ['@hockney'], description: 'Test coverage, Vitest, edge cases, CI/CD, quality gates' },
      { pattern: 'documentation', agents: ['@mcmanus'], description: 'README, API docs, getting-started, demos, tone review' },
      { pattern: 'architecture', agents: ['@keaton'], description: 'Product direction, architectural decisions, code review, scope' },
      { pattern: 'distribution', agents: ['@rabin'], description: 'npm packaging, esbuild config, global install, marketplace prep' },
      { pattern: 'git-releases', agents: ['@kobayashi'], description: 'Semantic versioning, GitHub Releases, CI/CD, branch protection' },
      { pattern: 'security', agents: ['@baer'], description: 'Hook design, PII filters, security review, compliance' },
      { pattern: 'visual-identity', agents: ['@redfoot'], description: 'Logo, icons, brand assets, design system' },
      { pattern: 'observability', agents: ['@saul'], description: 'Aspire dashboard, OTLP integration, Playwright E2E, Docker telemetry' },
      { pattern: 'vscode-integration', agents: ['@strausz'], description: 'VS Code Extension API, runSubagent compatibility' },
      { pattern: 'repl-shell', agents: ['@kovash'], description: 'Interactive shell, Ink components, session dispatch' },
      { pattern: 'cli-ux', agents: ['@marquez'], description: 'Interaction design, copy, spacing, affordances, UX gates' },
      { pattern: 'tui', agents: ['@cheritto'], description: 'Ink components, layout, input handling, focus management' },
      { pattern: 'e2e-tests', agents: ['@breedan'], description: 'node-pty harness, Gherkin features, frame snapshots' },
      { pattern: 'accessibility', agents: ['@nate'], description: 'Keyboard nav, color contrast, error guidance' },
      { pattern: 'hostile-qa', agents: ['@waingro'], description: 'Adversarial testing, edge cases, regression scenarios' },
    ],
    defaultAgent: '@keaton',
    fallback: 'coordinator',
  }),

  casting: defineCasting({
    allowlistUniverses: ['The Usual Suspects', 'Breaking Bad', 'The Wire', 'Firefly'],
    overflowStrategy: 'generic',
  }),
});
