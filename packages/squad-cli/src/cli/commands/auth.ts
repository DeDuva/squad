import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const GEMINI_CONFIG_DIR = join(homedir(), '.config', 'squad');
const GEMINI_CONFIG_FILE = join(GEMINI_CONFIG_DIR, 'gemini.json');
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function loadStoredKey(): string | undefined {
  try {
    if (!existsSync(GEMINI_CONFIG_FILE)) return undefined;
    const raw = readFileSync(GEMINI_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined;
  } catch {
    return undefined;
  }
}

function storeKey(apiKey: string): void {
  mkdirSync(GEMINI_CONFIG_DIR, { recursive: true });
  writeFileSync(GEMINI_CONFIG_FILE, JSON.stringify({ apiKey }, null, 2) + '\n', { mode: 0o600 });
}

async function validateKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${GEMINI_BASE}/models?key=${apiKey}`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function runAuth(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'status';

  if (subcommand === 'setup') {
    const providerIdx = args.indexOf('--provider');
    const provider = providerIdx !== -1 ? args[providerIdx + 1] : 'gemini';

    if (provider === 'anthropic') {
      // There is nothing to set up. squad stores no Anthropic credential —
      // the Agent SDK inherits whatever the local `claude` CLI is signed in
      // with, or ANTHROPIC_API_KEY when one is set. Saying so beats
      // rejecting the command as unsupported.
      if (process.env['ANTHROPIC_API_KEY']) {
        console.log('✓ Anthropic is configured via ANTHROPIC_API_KEY.');
      } else {
        console.log('✓ Anthropic needs no setup here.');
        console.log('  Squad uses whatever credentials your local `claude` CLI is signed in with.');
        console.log('  Run `claude` and use /login if you are not signed in yet.');
      }
      console.log('  Verify with: squad doctor');
      return;
    }

    if (provider !== 'gemini') {
      console.error(`✗ Unsupported provider: ${provider}. Supported: anthropic, gemini.`);
      process.exit(1);
    }

    // Read key from --key flag, env var, or stored config
    const keyIdx = args.indexOf('--key');
    let apiKey = keyIdx !== -1 ? args[keyIdx + 1] : undefined;

    if (!apiKey) {
      apiKey = process.env['GEMINI_API_KEY'];
    }

    if (!apiKey) {
      apiKey = loadStoredKey();
    }

    if (!apiKey) {
      console.error(
        `✗ No Gemini API key found.\n\n` +
        `  Options:\n` +
        `    squad auth setup --provider=gemini --key YOUR_KEY\n` +
        `    export GEMINI_API_KEY=YOUR_KEY && squad auth setup --provider=gemini\n\n` +
        `  Get a key at: https://aistudio.google.com/app/apikey\n`,
      );
      process.exit(1);
    }

    console.log('Validating Gemini API key...');
    const valid = await validateKey(apiKey);

    if (!valid) {
      console.error(
        `✗ Gemini API key validation failed.\n` +
        `  Check the key is correct and has access to the Generative Language API.\n` +
        `  Get a key at: https://aistudio.google.com/app/apikey\n`,
      );
      process.exit(1);
    }

    storeKey(apiKey);
    console.log(`✓ Gemini API key validated and stored at ${GEMINI_CONFIG_FILE}`);
    console.log(`  Squad will use this key by default. Override with GEMINI_API_KEY env var.\n`);
    return;
  }

  if (subcommand === 'status') {
    const apiKey = process.env['GEMINI_API_KEY'] ?? loadStoredKey();

    if (!apiKey) {
      console.log(`  Gemini: ✗ not configured`);
      console.log(`  Run: squad auth setup --provider=gemini --key YOUR_KEY\n`);
      return;
    }

    console.log('Checking Gemini API key...');
    const valid = await validateKey(apiKey);
    const source = process.env['SQUAD_GEMINI_KEY_SOURCE']
      ? process.env['SQUAD_GEMINI_KEY_SOURCE']
      : process.env['GEMINI_API_KEY']
        ? 'GEMINI_API_KEY env var'
        : GEMINI_CONFIG_FILE;

    if (valid) {
      console.log(`  Gemini: ✓ authenticated (source: ${source})\n`);
    } else {
      console.log(`  Gemini: ✗ key found but validation failed (source: ${source})`);
      console.log(`  Run: squad auth setup --provider=gemini --key YOUR_KEY\n`);
    }
    return;
  }

  if (subcommand === 'logout') {
    if (existsSync(GEMINI_CONFIG_FILE)) {
      writeFileSync(GEMINI_CONFIG_FILE, JSON.stringify({}, null, 2) + '\n', { mode: 0o600 });
      console.log(`✓ Gemini API key removed from ${GEMINI_CONFIG_FILE}`);
    } else {
      console.log('No stored Gemini credentials found.');
    }
    return;
  }

  console.error(`Unknown auth subcommand: ${subcommand}`);
  console.error('Usage: squad auth setup|status|logout [--provider=gemini] [--key KEY]');
  process.exit(1);
}
