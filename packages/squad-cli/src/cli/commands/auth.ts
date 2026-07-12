import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = join(homedir(), '.config', 'squad');
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

type ProviderName = 'gemini' | 'anthropic';

interface ProviderAuthConfig {
  configFile: string;
  envVar: string;
  sourceEnvVar: string;
  validate: (apiKey: string) => Promise<boolean>;
  getKeyUrl: string;
}

async function validateGeminiKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${GEMINI_BASE}/models?key=${apiKey}`);
    return res.ok;
  } catch {
    return false;
  }
}

async function validateAnthropicKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE}/models`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

const PROVIDERS: Record<ProviderName, ProviderAuthConfig> = {
  gemini: {
    configFile: join(CONFIG_DIR, 'gemini.json'),
    envVar: 'GEMINI_API_KEY',
    sourceEnvVar: 'SQUAD_GEMINI_KEY_SOURCE',
    validate: validateGeminiKey,
    getKeyUrl: 'https://aistudio.google.com/app/apikey',
  },
  anthropic: {
    configFile: join(CONFIG_DIR, 'anthropic.json'),
    envVar: 'ANTHROPIC_API_KEY',
    sourceEnvVar: 'SQUAD_ANTHROPIC_KEY_SOURCE',
    validate: validateAnthropicKey,
    getKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
};

function isProviderName(value: string): value is ProviderName {
  return value === 'gemini' || value === 'anthropic';
}

function loadStoredKey(provider: ProviderAuthConfig): string | undefined {
  try {
    if (!existsSync(provider.configFile)) return undefined;
    const raw = readFileSync(provider.configFile, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined;
  } catch {
    return undefined;
  }
}

function storeKey(provider: ProviderAuthConfig, apiKey: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(provider.configFile, JSON.stringify({ apiKey }, null, 2) + '\n', { mode: 0o600 });
}

export async function runAuth(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'status';

  if (subcommand === 'setup') {
    const providerIdx = args.indexOf('--provider');
    const providerName = providerIdx !== -1 ? args[providerIdx + 1] : 'gemini';

    if (!providerName || !isProviderName(providerName)) {
      console.error(`✗ Unsupported provider: ${providerName}. Supported providers: gemini, anthropic.`);
      process.exit(1);
    }

    const provider = PROVIDERS[providerName];
    const label = providerName === 'gemini' ? 'Gemini' : 'Anthropic';

    // Read key from --key flag, env var, or stored config
    const keyIdx = args.indexOf('--key');
    let apiKey = keyIdx !== -1 ? args[keyIdx + 1] : undefined;

    if (!apiKey) {
      apiKey = process.env[provider.envVar];
    }

    if (!apiKey) {
      apiKey = loadStoredKey(provider);
    }

    if (!apiKey) {
      console.error(
        `✗ No ${label} API key found.\n\n` +
        `  Options:\n` +
        `    squad auth setup --provider=${providerName} --key YOUR_KEY\n` +
        `    export ${provider.envVar}=YOUR_KEY && squad auth setup --provider=${providerName}\n\n` +
        `  Get a key at: ${provider.getKeyUrl}\n`,
      );
      process.exit(1);
    }

    console.log(`Validating ${label} API key...`);
    const valid = await provider.validate(apiKey);

    if (!valid) {
      console.error(
        `✗ ${label} API key validation failed.\n` +
        `  Check the key is correct and has access to the API.\n` +
        `  Get a key at: ${provider.getKeyUrl}\n`,
      );
      process.exit(1);
    }

    storeKey(provider, apiKey);
    console.log(`✓ ${label} API key validated and stored at ${provider.configFile}`);
    console.log(`  Squad will use this key by default. Override with ${provider.envVar} env var.\n`);
    return;
  }

  if (subcommand === 'status') {
    for (const [providerName, provider] of Object.entries(PROVIDERS) as Array<[ProviderName, ProviderAuthConfig]>) {
      const label = providerName === 'gemini' ? 'Gemini' : 'Anthropic';
      const apiKey = process.env[provider.envVar] ?? loadStoredKey(provider);

      if (!apiKey) {
        console.log(`  ${label}: ✗ not configured`);
        console.log(`  Run: squad auth setup --provider=${providerName} --key YOUR_KEY\n`);
        continue;
      }

      console.log(`Checking ${label} API key...`);
      const valid = await provider.validate(apiKey);
      const source = process.env[provider.sourceEnvVar]
        ? process.env[provider.sourceEnvVar]
        : process.env[provider.envVar]
          ? `${provider.envVar} env var`
          : provider.configFile;

      if (valid) {
        console.log(`  ${label}: ✓ authenticated (source: ${source})\n`);
      } else {
        console.log(`  ${label}: ✗ key found but validation failed (source: ${source})`);
        console.log(`  Run: squad auth setup --provider=${providerName} --key YOUR_KEY\n`);
      }
    }
    return;
  }

  if (subcommand === 'logout') {
    const providerIdx = args.indexOf('--provider');
    const providerName = providerIdx !== -1 ? args[providerIdx + 1] : 'gemini';

    if (!providerName || !isProviderName(providerName)) {
      console.error(`✗ Unsupported provider: ${providerName}. Supported providers: gemini, anthropic.`);
      process.exit(1);
    }

    const provider = PROVIDERS[providerName];
    const label = providerName === 'gemini' ? 'Gemini' : 'Anthropic';

    if (existsSync(provider.configFile)) {
      writeFileSync(provider.configFile, JSON.stringify({}, null, 2) + '\n', { mode: 0o600 });
      console.log(`✓ ${label} API key removed from ${provider.configFile}`);
    } else {
      console.log(`No stored ${label} credentials found.`);
    }
    return;
  }

  console.error(`Unknown auth subcommand: ${subcommand}`);
  console.error('Usage: squad auth setup|status|logout [--provider=gemini|anthropic] [--key KEY]');
  process.exit(1);
}
