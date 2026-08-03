/**
 * Config command — manage squad configuration.
 *
 * Usage:
 *   squad config model                          — show current model configuration
 *   squad config model <model-name>             — set default model for all agents
 *   squad config model <model-name> --agent <n> — pin model to a specific agent
 *   squad config model --clear                  — clear default model override
 *   squad config model --clear --agent <n>      — clear a specific agent's override
 */

import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import {
  readModelPreference,
  writeModelPreference,
  readAgentModelOverrides,
  writeAgentModelOverrides,
  readProviderPreference,
  writeProviderPreference,
  MODEL_CATALOG,
} from '@deduvafork/squad-sdk/config';
import { fatal } from '../core/errors.js';
import { BOLD, RESET, GREEN, DIM, RED, YELLOW } from '../core/output.js';

function resolveSquadDir(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, '.squad');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function listAgents(squadDir: string): string[] {
  const agentsDir = join(squadDir, 'agents');
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function isValidModel(name: string): boolean {
  return MODEL_CATALOG.some(m => m.id === name);
}

function showAvailableModels(): void {
  console.log(`\n  Available models:`);
  const byTier = new Map<string, string[]>();
  for (const m of MODEL_CATALOG) {
    const list = byTier.get(m.tier) ?? [];
    list.push(m.id);
    byTier.set(m.tier, list);
  }
  for (const [tier, models] of byTier) {
    console.log(`    ${BOLD}${tier}${RESET}: ${DIM}${models.join(', ')}${RESET}`);
  }
  console.log();
}

function parseFlags(args: string[]): { clear: boolean; agent: string | null; positional: string[] } {
  let clear = false;
  let agent: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--clear') {
      clear = true;
    } else if (arg === '--agent') {
      agent = args[++i] ?? null;
      if (!agent) {
        fatal('--agent requires a name argument.');
      }
    } else if (arg && !arg.startsWith('-')) {
      positional.push(arg);
    }
  }
  return { clear, agent, positional };
}


/** Backends `squad config provider` accepts. */
const PROVIDERS = ['anthropic', 'gemini'] as const;

async function runProviderSubcommand(squadDir: string, subArgs: string[]): Promise<void> {
  const { clear, positional } = parseFlags(subArgs);

  if (clear) {
    writeProviderPreference(squadDir, null);
    console.log(`${GREEN}\u2713${RESET} Provider override cleared (reverted to auto-selection).`);
    return;
  }

  const arg = positional[0]?.toLowerCase() ?? null;

  if (arg) {
    if (!(PROVIDERS as readonly string[]).includes(arg)) {
      console.error(`${RED}\u2717${RESET} Unknown provider: ${BOLD}${arg}${RESET}`);
      console.error(`       Known providers: ${PROVIDERS.join(', ')}`);
      process.exit(1);
    }
    writeProviderPreference(squadDir, arg as 'anthropic' | 'gemini');
    console.log(`${GREEN}\u2713${RESET} Provider set to ${BOLD}${arg}${RESET}.`);
    if (arg === 'anthropic') {
      console.log(`  Uses whatever credentials your local \`claude\` CLI is signed in with,`);
      console.log(`  or ANTHROPIC_API_KEY when one is set.`);
    }
    return;
  }

  // --- Show current ---
  const configured = readProviderPreference(squadDir);
  const fromEnv = process.env['SQUAD_PROVIDER'];
  console.log(`\n${BOLD}Provider${RESET}\n`);
  console.log(`  configured : ${configured ?? `${DIM}(unset)${RESET}`}`);
  if (fromEnv) console.log(`  SQUAD_PROVIDER : ${fromEnv}`);
  console.log(`  effective  : ${BOLD}${configured ?? (fromEnv && (PROVIDERS as readonly string[]).includes(fromEnv) ? fromEnv : 'anthropic')}${RESET}\n`);
}

async function runModelSubcommand(squadDir: string, subArgs: string[]): Promise<void> {
  const { clear, agent, positional } = parseFlags(subArgs);
  const modelArg = positional[0] ?? null;

  // --- Clear ---
  if (clear) {
    if (agent) {
      const agents = listAgents(squadDir);
      if (agents.length > 0 && !agents.includes(agent)) {
        fatal(
          `Unknown agent "${agent}".\n` +
          `       Known agents: ${agents.join(', ')}`,
        );
      }
      const overrides = readAgentModelOverrides(squadDir);
      delete overrides[agent];
      writeAgentModelOverrides(squadDir, overrides);
      console.log(`${GREEN}✓${RESET} Model override for ${BOLD}${agent}${RESET} cleared.`);
    } else {
      writeModelPreference(squadDir, null);
      console.log(`${GREEN}✓${RESET} Default model override cleared (reverted to auto-selection).`);
    }
    return;
  }

  // --- Set model ---
  if (modelArg) {
    if (!isValidModel(modelArg)) {
      console.error(`${RED}✗${RESET} Unknown model: ${BOLD}${modelArg}${RESET}`);
      showAvailableModels();
      process.exit(1);
    }

    if (agent) {
      const agents = listAgents(squadDir);
      if (agents.length > 0 && !agents.includes(agent)) {
        fatal(
          `Unknown agent "${agent}".\n` +
          `       Known agents: ${agents.join(', ')}`,
        );
      }
      const overrides = readAgentModelOverrides(squadDir);
      overrides[agent] = modelArg;
      writeAgentModelOverrides(squadDir, overrides);
      console.log(`${GREEN}✓${RESET} Model for ${BOLD}${agent}${RESET} set to ${BOLD}${modelArg}${RESET}`);
    } else {
      writeModelPreference(squadDir, modelArg);
      console.log(`${GREEN}✓${RESET} Default model set to ${BOLD}${modelArg}${RESET}`);
    }
    return;
  }

  // --- Show current config ---
  const defaultModel = readModelPreference(squadDir);
  const overrides = readAgentModelOverrides(squadDir);
  const overrideEntries = Object.entries(overrides);

  console.log(`\n${BOLD}Model configuration:${RESET}`);
  console.log(`  Default model: ${defaultModel ? BOLD + defaultModel + RESET : `${DIM}(auto)${RESET}`}`);

  if (overrideEntries.length > 0) {
    console.log(`\n  Agent overrides:`);
    for (const [name, model] of overrideEntries) {
      console.log(`    ${name} ${DIM}→${RESET} ${model}`);
    }
  } else {
    console.log(`\n  ${DIM}No agent overrides configured.${RESET}`);
  }
  console.log();
}

export async function runConfig(cwd: string, subArgs: string[]): Promise<void> {
  const squadDir = resolveSquadDir(cwd);
  if (!squadDir) {
    fatal('No squad found. Run "squad init" first.');
    return;
  }

  const sub = subArgs[0]?.toLowerCase();

  if (sub === 'model') {
    await runModelSubcommand(squadDir, subArgs.slice(1));
    return;
  }

  if (sub === 'provider') {
    await runProviderSubcommand(squadDir, subArgs.slice(1));
    return;
  }

  // No subcommand or unknown — show usage
  console.log(`\n${BOLD}squad config${RESET} — manage squad configuration\n`);
  console.log(`  ${BOLD}squad config model${RESET}                          — show current model config`);
  console.log(`  ${BOLD}squad config model <model>${RESET}                  — set default model`);
  console.log(`  ${BOLD}squad config model <model> --agent <name>${RESET}   — pin model to agent`);
  console.log(`  ${BOLD}squad config model --clear${RESET}                  — clear default model`);
  console.log(`  ${BOLD}squad config model --clear --agent <name>${RESET}   — clear agent override`);
  console.log(`  ${BOLD}squad config provider${RESET}                       — show current backend`);
  console.log(`  ${BOLD}squad config provider <anthropic|gemini>${RESET}    — set backend`);
  console.log(`  ${BOLD}squad config provider --clear${RESET}               — clear backend override\n`);
}
