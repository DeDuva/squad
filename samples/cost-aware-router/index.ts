/**
 * Cost-Aware Router — Squad SDK Sample
 *
 * Demonstrates how Squad selects response tiers based on task complexity,
 * tracks costs per-agent with budget warnings, and produces a final report.
 *
 * Run:  npm run dev
 */

import {
  CostTracker,
  selectResponseTier,
  getTier,
  MODELS,
} from '@deduvafork/squad-sdk';

import type {
  ResponseTier,
  TierName,
  SquadConfig,
} from '@deduvafork/squad-sdk';

// ─────────────────────────────────────────────────────────────────────────────
// Terminal helpers
// ─────────────────────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m',
  bgCyan: '\x1b[46m',
  bgBlue: '\x1b[44m',
};

function pad(str: string, len: number): string {
  // Strip ANSI for length calculation
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  return str + ' '.repeat(Math.max(0, len - stripped.length));
}

function rpad(str: string, len: number): string {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  return ' '.repeat(Math.max(0, len - stripped.length)) + str;
}

function hr(char = '─', len = 72): string {
  return c.dim + char.repeat(len) + c.reset;
}

function header(title: string): void {
  console.log();
  console.log(hr('━'));
  console.log(`${c.bold}${c.cyan}  ${title}${c.reset}`);
  console.log(hr('━'));
}

function subheader(title: string): void {
  console.log();
  console.log(`${c.bold}  ${title}${c.reset}`);
  console.log(`  ${c.dim}${'─'.repeat(68)}${c.reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier visuals
// ─────────────────────────────────────────────────────────────────────────────

const TIER_COLORS: Record<TierName, string> = {
  direct: c.green,
  lightweight: c.cyan,
  standard: c.yellow,
  full: c.magenta,
};

const TIER_BADGES: Record<TierName, string> = {
  direct: `${c.bgGreen}${c.bold} DIRECT ${c.reset}`,
  lightweight: `${c.bgCyan}${c.bold} LIGHTWEIGHT ${c.reset}`,
  standard: `${c.bgYellow}${c.bold} STANDARD ${c.reset}`,
  full: `${c.bgRed}${c.bold} FULL ${c.reset}`,
};

const TIER_ICONS: Record<TierName, string> = {
  direct: '⚡',
  lightweight: '🔹',
  standard: '🔶',
  full: '🔴',
};

// ─────────────────────────────────────────────────────────────────────────────
// Cost estimation helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ModelCost {
  name: string;
  inputPer1k: number;
  outputPer1k: number;
}

const MODEL_COSTS: Record<string, ModelCost> = {
  none: { name: '(no model)', inputPer1k: 0, outputPer1k: 0 },
  fast: { name: MODELS.FALLBACK_CHAINS.fast[0], inputPer1k: 0.0008, outputPer1k: 0.004 },
  standard: { name: MODELS.FALLBACK_CHAINS.standard[0], inputPer1k: 0.003, outputPer1k: 0.015 },
  premium: { name: MODELS.FALLBACK_CHAINS.premium[0], inputPer1k: 0.015, outputPer1k: 0.075 },
};

function estimateCost(tier: ResponseTier, inputTokens: number, outputTokens: number): number {
  const mc = MODEL_COSTS[tier.modelTier] ?? MODEL_COSTS['standard'];
  return (inputTokens / 1000) * mc.inputPer1k + (outputTokens / 1000) * mc.outputPer1k;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task definitions
// ─────────────────────────────────────────────────────────────────────────────

interface Task {
  name: string;
  description: string;
  message: string;
  agent: string;
  simInputTokens: number;
  simOutputTokens: number;
}

const TASKS: Task[] = [
  {
    name: 'Typo Fix',
    description: 'Fix a one-character typo in the README',
    message: 'Fix typo in README: "teh" → "the"',
    agent: 'Cheritto',
    simInputTokens: 200,
    simOutputTokens: 50,
  },
  {
    name: 'Docs Update',
    description: 'Update API reference for new endpoint',
    message: 'List the outdated docs pages and update the API reference',
    agent: 'McManus',
    simInputTokens: 1200,
    simOutputTokens: 800,
  },
  {
    name: 'Feature Impl',
    description: 'Implement webhook retry with exponential backoff',
    message: 'Implement a new feature: webhook retry module with exponential backoff and dead-letter queue',
    agent: 'Verbal',
    simInputTokens: 8000,
    simOutputTokens: 4000,
  },
  {
    name: 'Arch Review',
    description: 'Full review of the event-driven architecture',
    message: 'Full review of the event bus architecture — check coupling, error flows, and scaling limits',
    agent: 'Keaton',
    simInputTokens: 15000,
    simOutputTokens: 6000,
  },
  {
    name: 'Security Audit',
    description: 'Multi-agent security audit of auth subsystem',
    message: 'Security audit of the authentication and authorization subsystem — check token handling, session fixation, CSRF',
    agent: 'Fenster',
    simInputTokens: 20000,
    simOutputTokens: 10000,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Config (minimal — just enough for selectResponseTier)
// ─────────────────────────────────────────────────────────────────────────────

const config: SquadConfig = {
  version: '0.8.0',
  team: { name: 'MVP Summit Demo' },
  routing: {
    rules: [
      { pattern: 'typo', agents: ['Cheritto'], tier: 'direct' },
    ],
  },
  models: {
    default: MODELS.DEFAULT,
    defaultTier: 'standard',
    tiers: {
      premium: [...MODELS.FALLBACK_CHAINS.premium],
      standard: [...MODELS.FALLBACK_CHAINS.standard],
      fast: [...MODELS.FALLBACK_CHAINS.fast],
    },
  },
  agents: [
    { name: 'Cheritto', role: 'developer' },
    { name: 'McManus', role: 'scribe' },
    { name: 'Verbal', role: 'developer' },
    { name: 'Keaton', role: 'lead' },
    { name: 'Fenster', role: 'tester' },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Budget tracking
// ─────────────────────────────────────────────────────────────────────────────

const BUDGET_LIMIT = 0.50; // $0.50 demo budget

function budgetBar(spent: number, limit: number): string {
  const pct = Math.min(spent / limit, 1);
  const barLen = 30;
  const filled = Math.round(pct * barLen);
  const empty = barLen - filled;

  let barColor = c.green;
  if (pct > 0.9) barColor = c.red;
  else if (pct > 0.7) barColor = c.yellow;

  const bar = barColor + '█'.repeat(filled) + c.dim + '░'.repeat(empty) + c.reset;
  const pctStr = `${(pct * 100).toFixed(1)}%`;
  return `  ${bar}  ${barColor}${c.bold}$${spent.toFixed(4)}${c.reset}${c.dim} / $${limit.toFixed(2)}${c.reset}  (${pctStr})`;
}

function checkBudgetWarning(spent: number, limit: number): void {
  const pct = spent / limit;
  if (pct >= 0.9) {
    console.log(`  ${c.red}${c.bold}⚠  BUDGET CRITICAL — ${(pct * 100).toFixed(0)}% consumed!${c.reset}`);
  } else if (pct >= 0.7) {
    console.log(`  ${c.yellow}${c.bold}⚠  Budget warning — ${(pct * 100).toFixed(0)}% consumed${c.reset}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulated delay
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Banner ──
  console.log();
  console.log(`${c.bold}${c.cyan}  ┌──────────────────────────────────────────────────────────────┐${c.reset}`);
  console.log(`${c.bold}${c.cyan}  │                                                              │${c.reset}`);
  console.log(`${c.bold}${c.cyan}  │   ${c.white}Squad SDK — Cost-Aware Router Demo${c.cyan}                        │${c.reset}`);
  console.log(`${c.bold}${c.cyan}  │   ${c.dim}Tier selection · Budget tracking · Cost breakdowns${c.cyan}${c.bold}          │${c.reset}`);
  console.log(`${c.bold}${c.cyan}  │                                                              │${c.reset}`);
  console.log(`${c.bold}${c.cyan}  └──────────────────────────────────────────────────────────────┘${c.reset}`);

  // ── Model catalogue ──
  header('MODEL CATALOGUE');
  console.log();
  console.log(`  ${c.bold}${pad('Tier', 12)}${pad('Model', 28)}${rpad('Input/1k', 12)}${rpad('Output/1k', 12)}${c.reset}`);
  console.log(`  ${c.dim}${'─'.repeat(12)}${'─'.repeat(28)}${'─'.repeat(12)}${'─'.repeat(12)}${c.reset}`);

  for (const [tier, info] of Object.entries(MODEL_COSTS)) {
    if (tier === 'none') continue;
    const tierColor = tier === 'fast' ? c.cyan : tier === 'standard' ? c.yellow : c.magenta;
    console.log(
      `  ${tierColor}${pad(tier.toUpperCase(), 12)}${c.reset}` +
      `${pad(info.name, 28)}` +
      `${rpad('$' + info.inputPer1k.toFixed(4), 12)}` +
      `${rpad('$' + info.outputPer1k.toFixed(4), 12)}`
    );
  }

  // ── Budget ──
  header(`BUDGET: $${BUDGET_LIMIT.toFixed(2)}`);
  console.log(budgetBar(0, BUDGET_LIMIT));

  // ── CostTracker ──
  const tracker = new CostTracker();

  // ── Process tasks ──
  header('TASK ROUTING');

  const tierCounts: Record<TierName, number> = { direct: 0, lightweight: 0, standard: 0, full: 0 };

  for (let i = 0; i < TASKS.length; i++) {
    const task = TASKS[i];
    const num = `${i + 1}/${TASKS.length}`;

    // Select tier
    const tier = selectResponseTier(task.message, config);
    tierCounts[tier.tier]++;

    const mc = MODEL_COSTS[tier.modelTier] ?? MODEL_COSTS['standard'];
    const cost = estimateCost(tier, task.simInputTokens, task.simOutputTokens);

    subheader(`Task ${num}: ${task.name}`);
    console.log(`  ${c.dim}Description:${c.reset}  ${task.description}`);
    console.log(`  ${c.dim}Agent:${c.reset}        ${c.bold}${task.agent}${c.reset}`);
    console.log(`  ${c.dim}Message:${c.reset}      "${task.message}"`);
    console.log();

    // Tier decision
    console.log(`  ${c.bold}Decision:${c.reset}     ${TIER_BADGES[tier.tier]}  ${TIER_ICONS[tier.tier]}`);
    console.log(`  ${c.dim}Model tier:${c.reset}   ${TIER_COLORS[tier.tier]}${tier.modelTier}${c.reset} → ${c.bold}${mc.name}${c.reset}`);
    console.log(`  ${c.dim}Max agents:${c.reset}   ${tier.maxAgents}    ${c.dim}Timeout:${c.reset} ${tier.timeout}s`);
    console.log(`  ${c.dim}Est. cost:${c.reset}    ${c.bold}$${cost.toFixed(4)}${c.reset}  (${task.simInputTokens.toLocaleString()} in / ${task.simOutputTokens.toLocaleString()} out)`);

    // Simulate running
    console.log();
    process.stdout.write(`  ${c.dim}Running...${c.reset}`);
    await sleep(300);
    process.stdout.write(` ${c.green}✓ done${c.reset}\n`);

    // Record cost
    tracker.recordUsage({
      sessionId: `session-${task.agent.toLowerCase()}-${i + 1}`,
      agentName: task.agent,
      model: mc.name,
      inputTokens: task.simInputTokens,
      outputTokens: task.simOutputTokens,
      estimatedCost: cost,
    });

    // Running budget
    const summary = tracker.getSummary();
    console.log();
    console.log(`  ${c.bold}Running total:${c.reset}`);
    console.log(budgetBar(summary.totalEstimatedCost, BUDGET_LIMIT));
    checkBudgetWarning(summary.totalEstimatedCost, BUDGET_LIMIT);
  }

  // ── Tier breakdown ──
  header('TIER DISTRIBUTION');
  console.log();

  const maxCount = Math.max(...Object.values(tierCounts), 1);
  for (const tierName of ['direct', 'lightweight', 'standard', 'full'] as TierName[]) {
    const count = tierCounts[tierName];
    const barLen = Math.round((count / maxCount) * 20);
    const bar = TIER_COLORS[tierName] + '█'.repeat(barLen) + c.reset;
    console.log(`  ${pad(TIER_ICONS[tierName] + ' ' + tierName.toUpperCase(), 18)} ${bar} ${c.bold}${count}${c.reset}`);
  }

  // ── Per-agent breakdown ──
  header('AGENT COST BREAKDOWN');
  console.log();

  const finalSummary = tracker.getSummary();

  console.log(
    `  ${c.bold}` +
    `${pad('Agent', 14)}` +
    `${pad('Model', 24)}` +
    `${rpad('Tokens In', 12)}` +
    `${rpad('Tokens Out', 12)}` +
    `${rpad('Cost', 12)}` +
    `${rpad('Turns', 8)}` +
    `${c.reset}`
  );
  console.log(`  ${c.dim}${'─'.repeat(14)}${'─'.repeat(24)}${'─'.repeat(12)}${'─'.repeat(12)}${'─'.repeat(12)}${'─'.repeat(8)}${c.reset}`);

  for (const [name, entry] of finalSummary.agents) {
    const costColor = entry.estimatedCost > 1.0 ? c.red : entry.estimatedCost > 0.1 ? c.yellow : c.green;
    console.log(
      `  ${c.bold}${pad(name, 14)}${c.reset}` +
      `${c.dim}${pad(entry.model, 24)}${c.reset}` +
      `${rpad(entry.inputTokens.toLocaleString(), 12)}` +
      `${rpad(entry.outputTokens.toLocaleString(), 12)}` +
      `${costColor}${rpad('$' + entry.estimatedCost.toFixed(4), 12)}${c.reset}` +
      `${rpad(String(entry.turnCount), 8)}`
    );
  }

  console.log(`  ${c.dim}${'─'.repeat(82)}${c.reset}`);
  console.log(
    `  ${c.bold}${pad('TOTAL', 14)}${c.reset}` +
    `${pad('', 24)}` +
    `${c.bold}${rpad(finalSummary.totalInputTokens.toLocaleString(), 12)}` +
    `${rpad(finalSummary.totalOutputTokens.toLocaleString(), 12)}` +
    `${rpad('$' + finalSummary.totalEstimatedCost.toFixed(4), 12)}${c.reset}` +
    `${rpad('', 8)}`
  );

  // ── Final report ──
  header('FINAL COST REPORT');
  console.log();
  console.log(budgetBar(finalSummary.totalEstimatedCost, BUDGET_LIMIT));
  console.log();

  const pct = (finalSummary.totalEstimatedCost / BUDGET_LIMIT) * 100;
  const remaining = BUDGET_LIMIT - finalSummary.totalEstimatedCost;

  console.log(`  ${c.dim}Total spent:${c.reset}      ${c.bold}$${finalSummary.totalEstimatedCost.toFixed(4)}${c.reset}`);
  console.log(`  ${c.dim}Budget remaining:${c.reset}  ${c.bold}${c.green}$${remaining.toFixed(4)}${c.reset}`);
  console.log(`  ${c.dim}Budget used:${c.reset}      ${c.bold}${pct.toFixed(1)}%${c.reset}`);
  console.log(`  ${c.dim}Total tokens:${c.reset}     ${finalSummary.totalInputTokens.toLocaleString()} in + ${finalSummary.totalOutputTokens.toLocaleString()} out = ${c.bold}${(finalSummary.totalInputTokens + finalSummary.totalOutputTokens).toLocaleString()}${c.reset}`);
  console.log(`  ${c.dim}Agents used:${c.reset}      ${finalSummary.agents.size}`);
  console.log(`  ${c.dim}Sessions:${c.reset}         ${finalSummary.sessions.size}`);

  console.log();
  console.log(`  ${c.green}${c.bold}✓${c.reset} ${c.dim}All tasks completed within budget.${c.reset}`);
  console.log();
  console.log(hr('━'));
  console.log();
}

main().catch((err) => {
  console.error(`${c.red}Fatal: ${err}${c.reset}`);
  process.exit(1);
});
