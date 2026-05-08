/**
 * Squad Remote Control — CLI Command
 *
 * `squad rc [--tunnel] [--agent-cmd <cmd>]` or `squad remote-control`
 * Starts the RemoteBridge, creates a devtunnel, shows QR code.
 * Optionally relays stdin/stdout to a custom agent process via --agent-cmd.
 */

import path from 'node:path';
// createReadStream retained — streaming not in StorageProvider scope
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FSStorageProvider, RemoteBridge } from '@deduvafork/squad-sdk';

const storage = new FSStorageProvider();
import type { RemoteBridgeConfig } from '@deduvafork/squad-sdk';
import {
  isDevtunnelAvailable,
  createTunnel,
  destroyTunnel,
  getMachineId,
  getGitInfo,
} from './rc-tunnel.js';

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

export interface RCOptions {
  tunnel: boolean;
  port: number;
  path?: string;
  agentCmd?: string;
}

export async function runRC(cwd: string, options: RCOptions): Promise<void> {
  const { repo, branch } = getGitInfo(cwd);
  const machine = getMachineId();

  // Resolve squad directory
  const squadDir = storage.existsSync(path.join(cwd, '.squad'))
    ? path.join(cwd, '.squad')
    : storage.existsSync(path.join(cwd, '.ai-team'))
      ? path.join(cwd, '.ai-team')
      : '';

  console.log(`\n${BOLD}🎮 Squad Remote Control${RESET}\n`);
  console.log(`  ${DIM}Repo:${RESET}    ${repo}`);
  console.log(`  ${DIM}Branch:${RESET}  ${branch}`);
  console.log(`  ${DIM}Machine:${RESET} ${machine}`);
  console.log(`  ${DIM}Squad:${RESET}   ${squadDir || 'not found'}\n`);

  // Load team roster if squad dir exists
  const agents: Array<{name: string; role: string}> = [];
  if (squadDir) {
    try {
      const teamMd = storage.readSync(path.join(squadDir, 'team.md')) ?? '';
      const memberLines = teamMd.split('\n').filter(l => l.startsWith('|') && l.includes('Active'));
      for (const line of memberLines) {
        const cols = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cols.length >= 2 && cols[0] !== 'Name') {
          agents.push({ name: cols[0]!, role: cols[1]! });
        }
      }
      console.log(`  ${GREEN}✓${RESET} Loaded ${agents.length} agents from team.md\n`);
    } catch {
      console.log(`  ${YELLOW}⚠${RESET} Could not read team.md\n`);
    }
  }

  // Agent passthrough will be set up after bridge starts (optional, via --agent-cmd)
  const { spawn: spawnChild } = await import('node:child_process');
  const { createInterface: createRL } = await import('node:readline');
  let agentReady = false;

  // Create bridge config (fallback when passthrough is NOT active)
  const config: RemoteBridgeConfig = {
    port: options.port || 0,
    maxHistory: 500,
    repo,
    branch,
    machine,
    squadDir,
    onPrompt: async (text) => {
      console.log(`  ${CYAN}←${RESET} ${DIM}Remote prompt:${RESET} ${text}`);
      bridge.addMessage('user', text);
      const agent = agents.length > 0 ? agents[0]! : { name: 'Assistant', role: 'General' };
      bridge.addMessage('agent', `[Agent passthrough not active] Echo: ${text}`, agent.name);
    },
    onDirectMessage: async (agentName, text) => {
      console.log(`  ${CYAN}←${RESET} ${DIM}Remote @${agentName}:${RESET} ${text}`);
      bridge.addMessage('user', `@${agentName} ${text}`);
      bridge.addMessage('agent', `[Agent passthrough not active] Echo: ${text}`, agentName);
    },
    onCommand: (name) => {
      console.log(`  ${CYAN}←${RESET} ${DIM}Remote /${name}${RESET}`);
      if (name === 'status') {
        bridge.addMessage('system', `Squad RC | Repo: ${repo} | Branch: ${branch} | Agents: ${agents.length} | Agent passthrough: ${agentReady ? 'active' : 'off'} | Connections: ${bridge.getConnectionCount()}`);
      } else if (name === 'agents') {
        const list = agents.map(a => `• ${a.name} (${a.role})`).join('\n');
        bridge.addMessage('system', `Team Roster:\n${list || 'No agents loaded'}`);
      } else {
        bridge.addMessage('system', `Unknown command: /${name}`);
      }
    },
  };

  // Start bridge
  const bridge = new RemoteBridge(config);

  // Serve PWA static files
  bridge.setStaticHandler((req, res) => {
    const uiDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../remote-ui'
    );

    // #18: Guard against malformed URI encoding
    let decodedUrl: string;
    try {
      const parsed = new URL(req.url || '/', `http://${req.headers.host}`);
      decodedUrl = decodeURIComponent(parsed.pathname);
    } catch {
      res.writeHead(400); res.end(); return;
    }
    if (decodedUrl.includes('..')) { res.writeHead(400); res.end(); return; }

    let filePath = path.join(uiDir, decodedUrl === '/' ? 'index.html' : decodedUrl.replace(/^\//, ''));

    // Security: prevent directory traversal
    if (!filePath.startsWith(uiDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // #2: EISDIR guard — check if path is a directory before createReadStream
    try {
      const stat = storage.statSync(filePath);
      if (stat?.isDirectory) {
        filePath = path.join(filePath, 'index.html');
        if (!storage.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
      } else if (!stat) { res.writeHead(404); res.end(); return; }
    } catch { res.writeHead(404); res.end(); return; }

    const ext = path.extname(filePath);
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };

    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    // #8: Handle createReadStream errors
    const stream = createReadStream(filePath);
    stream.on('error', () => { if (!res.headersSent) { res.writeHead(500); } res.end(); });
    stream.pipe(res);
  });

  const actualPort = await bridge.start();
  const localUrl = `http://localhost:${actualPort}`;

  // Initialize agent roster in bridge
  const allAgents = agents.map(a => ({ name: a.name, role: a.role, status: 'idle' as const }));
  if (allAgents.length > 0) {
    bridge.updateAgents(allAgents);
  }

  console.log(`  ${GREEN}✓${RESET} Bridge running on port ${BOLD}${actualPort}${RESET}`);
  console.log(`  ${DIM}Local:${RESET}   ${localUrl}\n`);

  // Optional: spawn a custom agent process as a transparent relay (dumb pipe)
  // Pass --agent-cmd to enable, e.g. --agent-cmd "gemini-cli --interactive"
  let agentProc: ReturnType<typeof spawnChild> | null = null;
  if (options.agentCmd) {
    const agentParts = options.agentCmd.trim().split(/\s+/);
    const agentBin = agentParts[0]!;
    const agentCmdArgs = agentParts.slice(1);
    console.log(`  ${DIM}Spawning agent: ${options.agentCmd}...${RESET}`);
    try {
      agentProc = spawnChild(agentBin, agentCmdArgs, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      agentProc.on('error', (err) => {
        console.log(`  ${YELLOW}⚠${RESET} Agent error: ${err.message}`);
      });
      agentProc.on('exit', (code) => {
        console.log(`  ${DIM}[agent] exited with code ${code}${RESET}`);
        agentReady = false;
      });
      agentProc.stderr?.on('data', (d: Buffer) => {
        const text = d.toString().trim();
        if (text) {
          console.log(`  ${DIM}[agent] ${text}${RESET}`);
        }
      });

      // agent stdout → all WebSocket clients
      const rl = createRL({ input: agentProc.stdout!, terminal: false });
      rl.on('line', (line) => {
        if (line.trim()) {
          console.log(`  ${GREEN}→${RESET} ${DIM}agent out: ${line.substring(0, 100)}${RESET}`);
          bridge.passthroughFromAgent(line);
        }
      });

      // WebSocket → agent stdin
      bridge.setPassthrough((msg) => {
        if (agentProc?.stdin?.writable) {
          console.log(`  ${CYAN}←${RESET} ${DIM}agent in: ${msg.substring(0, 100)}${RESET}`);
          agentProc.stdin.write(msg.endsWith('\n') ? msg : msg + '\n');
        }
      });

      agentReady = true;
      console.log(`  ${GREEN}✓${RESET} Agent passthrough active\n`);
    } catch (err) {
      console.log(`  ${YELLOW}⚠${RESET} Agent not available: ${(err as Error).message}\n`);
    }
  } else {
    console.log(`  ${DIM}No agent passthrough (bridge-only mode). Use --agent-cmd to enable.${RESET}\n`);
  }

  // Tunnel setup
  if (options.tunnel) {
    if (!isDevtunnelAvailable()) {
      console.log(`  ${YELLOW}⚠${RESET} devtunnel CLI not found. Install with:`);
      console.log(`    winget install Microsoft.devtunnel`);
      console.log(`    ${DIM}Then: devtunnel user login${RESET}\n`);
      console.log(`  ${DIM}Running in local-only mode.${RESET}\n`);
    } else {
      console.log(`  ${DIM}Creating tunnel...${RESET}`);
      try {
        const tunnel = await createTunnel(actualPort, { repo, branch, machine });
        console.log(`  ${GREEN}✓${RESET} Tunnel active: ${BOLD}${tunnel.url}${RESET}\n`);

        // Show QR code
        try {
          // @ts-ignore - no type declarations for qrcode-terminal
          const qrcode = (await import('qrcode-terminal')) as any;
          qrcode.default.generate(tunnel.url, { small: true }, (code: string) => {
            console.log(code);
          });
        } catch {
          // qrcode-terminal not available, skip
        }

        console.log(`  ${DIM}Scan QR code or open URL on your phone.${RESET}`);
        console.log(`  ${DIM}Auth: private — only your MS/GitHub account can connect.${RESET}\n`);
      } catch (err) {
        console.log(`  ${YELLOW}⚠${RESET} Tunnel failed: ${(err as Error).message}`);
        console.log(`  ${DIM}Running in local-only mode.${RESET}\n`);
      }
    }
  } else {
    console.log(`  ${DIM}No tunnel (local only). Use --tunnel for remote access.${RESET}\n`);
  }

  console.log(`  ${DIM}Press Ctrl+C to stop.${RESET}\n`);

  // Clean shutdown
  const cleanup = async () => {
    console.log(`\n  ${DIM}Shutting down...${RESET}`);
    clearInterval(checkInterval);
    agentProc?.kill();
    destroyTunnel();
    await bridge.stop();
    console.log(`  ${GREEN}✓${RESET} Stopped.\n`);
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Log connections
  const checkInterval = setInterval(() => {
    const count = bridge.getConnectionCount();
    if (count > 0) {
      process.stdout.write(`\r  ${GREEN}●${RESET} ${count} client(s) connected    `);
    }
  }, 5000);

  // Keep process alive
  await new Promise(() => {});
}
