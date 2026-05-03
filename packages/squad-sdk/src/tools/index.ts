/**
 * Tool Registry — Custom Tools API (PRD 2)
 *
 * Defines Squad's custom tools registered with the SDK via defineTool().
 * Tools provide agents with typed, validated orchestration primitives:
 *   - squad_route:  Route work to another agent via session pool
 *   - squad_decide: Write a typed decision to the inbox drop-box
 *   - squad_memory: Append to agent history (learnings, updates)
 *   - squad_status: Query session pool state
 *   - squad_skill:  Read/write agent skills
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SquadTool } from '../adapter/types.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { FSStorageProvider } from '../storage/fs-storage-provider.js';
import type { SquadState } from '../state/squad-state.js';
import { createWorkstationTools, type WorkstationToolsOptions } from './workstation.js';
import { defineTool } from './define-tool.js';

// Re-export so callers can import from '@deduvafork/squad-sdk/tools'
export { defineTool, sanitizeArgs } from './define-tool.js';
export type { WorkstationToolsOptions } from './workstation.js';
export { createWorkstationTools } from './workstation.js';

// --- Tool Types ---

export interface ToolResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export interface RouteRequest {
  /** Target agent name */
  targetAgent: string;
  /** Task description for the target agent */
  task: string;
  /** Priority level */
  priority?: 'low' | 'normal' | 'high' | 'critical';
  /** Context to pass to the target session */
  context?: string;
}

export interface DecisionRecord {
  /** Decision author (agent name) */
  author: string;
  /** Decision summary */
  summary: string;
  /** Full decision body */
  body: string;
  /** Related agents or PRDs */
  references?: string[];
}

/** Map tool-facing section names to valid HistorySection values. */
const SECTION_MAP: Record<string, 'Learnings' | 'Decisions' | 'Context'> = {
  learnings: 'Learnings',
  updates: 'Decisions',
  sessions: 'Context',
};

export interface MemoryEntry {
  /** Agent name */
  agent: string;
  /** Section to append to (learnings, updates, sessions) */
  section: 'learnings' | 'updates' | 'sessions';
  /** Content to append */
  content: string;
}

export interface StatusQuery {
  /** Filter by agent name */
  agentName?: string;
  /** Filter by session status */
  status?: string;
  /** Include detailed session metadata */
  verbose?: boolean;
}

export interface SkillRequest {
  /** Skill name (maps to .squad/skills/{name}/SKILL.md) */
  skillName: string;
  /** Operation: read the skill or write/update it */
  operation: 'read' | 'write';
  /** Skill content (required for write) */
  content?: string;
  /** Confidence level (required for write) */
  confidence?: 'low' | 'medium' | 'high';
}

// --- Error Sanitization ---

/**
 * Sanitize error messages before sending to LLM.
 * Strips absolute filesystem paths by replacing the squadRoot prefix with [team-root].
 */
function sanitizeErrorForLlm(error: unknown, squadRoot: string): string {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.replace(new RegExp(squadRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[team-root]');
}

// --- Tool Registry ---

export type AgentSessionFactory = (
  targetAgent: string,
  task: string,
  priority: RouteRequest['priority'],
  context?: string,
) => Promise<{ sessionId: string }>;

export interface ToolRegistryOptions {
  /**
   * Register the built-in workstation tools (workstation_bash, workstation_read_file,
   * workstation_write_file, workstation_list_dir, workstation_find_files).
   *
   * ⚠️  SECURITY: Enables full filesystem and shell access for agents. Use the
   * onPreToolUse hook to enforce per-call allow-lists or confirmation flows.
   *
   * @default false
   */
  enableWorkstationTools?: boolean;
  /** Options forwarded to createWorkstationTools() when enableWorkstationTools is true. */
  workstationOptions?: WorkstationToolsOptions;
}

export class ToolRegistry {
  private tools: Map<string, SquadTool<any>> = new Map();
  private squadRoot: string;
  private sessionPoolGetter?: () => any;
  private storage: StorageProvider;
  private state?: SquadState;
  private sessionFactory?: AgentSessionFactory;
  private registryOptions: ToolRegistryOptions;

  constructor(
    squadRoot = '.squad',
    sessionPoolGetter?: () => any,
    storage: StorageProvider = new FSStorageProvider(),
    state?: SquadState,
    sessionFactory?: AgentSessionFactory,
    options?: ToolRegistryOptions,
  ) {
    this.squadRoot = squadRoot;
    this.sessionPoolGetter = sessionPoolGetter;
    this.storage = storage;
    this.state = state;
    this.sessionFactory = sessionFactory;
    this.registryOptions = options ?? {};
    this.registerSquadTools();
  }

  private registerSquadTools(): void {
    // squad_route: Route work to another agent
    const squadRoute = defineTool<RouteRequest>({
      name: 'squad_route',
      description: 'Route a task to another agent in the squad. Creates a new session for the target agent with the specified task and context.',
      parameters: {
        type: 'object',
        properties: {
          targetAgent: {
            type: 'string',
            description: 'Name of the agent to route the task to',
          },
          task: {
            type: 'string',
            description: 'Description of the task for the target agent',
          },
          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high', 'critical'],
            description: 'Priority level for the routed task',
            default: 'normal',
          },
          context: {
            type: 'string',
            description: 'Additional context to pass to the target session',
          },
        },
        required: ['targetAgent', 'task'],
      },
      handler: async (args) => {
        if (!args.targetAgent || args.targetAgent.trim() === '') {
          return {
            textResultForLlm: 'Error: Target agent name is required',
            resultType: 'failure',
            error: 'Invalid target agent',
          };
        }

        if (!this.sessionFactory) {
          return {
            textResultForLlm: `squad_route: sessionFactory not configured. Task for ${args.targetAgent} was not dispatched.`,
            resultType: 'failure',
            error: 'sessionFactory not configured',
          };
        }

        try {
          const { sessionId } = await this.sessionFactory(
            args.targetAgent,
            args.task,
            args.priority ?? 'normal',
            args.context,
          );
          return {
            textResultForLlm: `Task routed to ${args.targetAgent} (session ${sessionId}). Priority: ${args.priority ?? 'normal'}.`,
            resultType: 'success',
            toolTelemetry: { targetAgent: args.targetAgent, sessionId, priority: args.priority ?? 'normal' },
          };
        } catch (error) {
          return {
            textResultForLlm: `Failed to route task to ${args.targetAgent}: ${sanitizeErrorForLlm(error, this.squadRoot)}`,
            resultType: 'failure',
            error: String(error),
          };
        }
      },
    });

    // squad_decide: Write a decision to the inbox
    const squadDecide = defineTool<DecisionRecord>({
      name: 'squad_decide',
      description: 'Write a decision to the team decision inbox. Decisions are stored in .squad/decisions/inbox/ for team review.',
      parameters: {
        type: 'object',
        properties: {
          author: {
            type: 'string',
            description: 'Agent name making the decision',
          },
          summary: {
            type: 'string',
            description: 'Brief summary of the decision',
          },
          body: {
            type: 'string',
            description: 'Full decision details and rationale',
          },
          references: {
            type: 'array',
            items: { type: 'string' },
            description: 'Related agents, PRDs, or issues',
          },
        },
        required: ['author', 'summary', 'body'],
      },
      handler: async (args) => {
        if (!/^[a-zA-Z0-9_-]+$/.test(args.author)) {
          return { textResultForLlm: 'Invalid author name: must contain only letters, numbers, hyphens, and underscores', resultType: 'failure', error: 'Invalid author' };
        }
        try {
          const inboxDir = path.join(this.squadRoot, 'decisions', 'inbox');

          const decisionId = randomUUID();
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const slug = args.summary
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 50);
          const filename = path.join(inboxDir, `${args.author}-${slug}.md`);

          const content = [
            `### ${timestamp}: ${args.summary}`,
            '',
            `**By:** ${args.author}`,
            `**What:** ${args.summary}`,
            args.references && args.references.length > 0
              ? `**References:** ${args.references.join(', ')}`
              : '',
            '',
            `**Why:** ${args.body}`,
            '',
          ].filter(Boolean).join('\n');

          await this.storage.write(filename, content);

          return {
            textResultForLlm: `Decision written: ${args.author}-${slug}.md (ID: ${decisionId})`,
            resultType: 'success',
            toolTelemetry: { decisionId, filename, slug },
          };
        } catch (error) {
          return {
            textResultForLlm: `Failed to write decision: ${sanitizeErrorForLlm(error, this.squadRoot)}`,
            resultType: 'failure',
            error: String(error),
          };
        }
      },
    });

    // squad_memory: Append to agent history
    const squadMemory = defineTool<MemoryEntry>({
      name: 'squad_memory',
      description: 'Append an entry to an agent\'s history file. Used to record learnings, updates, or session notes.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: 'Agent name whose history to update',
          },
          section: {
            type: 'string',
            enum: ['learnings', 'updates', 'sessions'],
            description: 'Section to append to',
          },
          content: {
            type: 'string',
            description: 'Content to append to the section',
          },
        },
        required: ['agent', 'section', 'content'],
      },
      handler: async (args) => {
        if (!/^[a-zA-Z0-9_-]+$/.test(args.agent)) {
          return { textResultForLlm: 'Invalid agent name: must contain only letters, numbers, hyphens, and underscores', resultType: 'failure', error: 'Invalid agent name' };
        }
        try {
          // Use SquadState agents collection when available
          if (this.state) {
            const handle = this.state.agents.get(args.agent);
            // Verify the agent exists by attempting to read charter
            try {
              await handle.charter();
            } catch {
              return {
                textResultForLlm: `Agent history file not found: agents/${args.agent}/history.md`,
                resultType: 'failure',
                error: 'History file does not exist',
              };
            }
            const sectionName = SECTION_MAP[args.section] ?? 'Learnings';
            const timestamp = new Date().toISOString().slice(0, 10);
            await handle.appendHistory(
              sectionName,
              { section: sectionName, content: args.content, timestamp },
            );
            return {
              textResultForLlm: `Appended to ${args.agent} history (${args.section})`,
              resultType: 'success',
              toolTelemetry: { agent: args.agent, section: args.section },
            };
          }

          // Fallback: raw StorageProvider
          const historyFile = path.join(this.squadRoot, 'agents', args.agent, 'history.md');

          if (!await this.storage.exists(historyFile)) {
            return {
              textResultForLlm: `Agent history file not found: agents/${args.agent}/history.md`,
              resultType: 'failure',
              error: 'History file does not exist',
            };
          }

          const sectionHeader = `## ${SECTION_MAP[args.section] ?? 'Learnings'}`;
          const timestamp = new Date().toISOString().slice(0, 10);
          const entry = `\n### ${timestamp}\n${args.content}\n`;

          let content = await this.storage.read(historyFile);
          if (content === undefined) {
            return {
              textResultForLlm: `Agent history file not readable: agents/${args.agent}/history.md`,
              resultType: 'failure',
              error: 'History file could not be read',
            };
          }

          // Find section and append
          const sectionIndex = content.indexOf(sectionHeader);
          if (sectionIndex !== -1) {
            // Find next section or end of file
            const nextSectionIndex = content.indexOf('\n## ', sectionIndex + sectionHeader.length);
            const insertIndex = nextSectionIndex === -1 ? content.length : nextSectionIndex;
            content = content.slice(0, insertIndex) + entry + content.slice(insertIndex);
          } else {
            // Section doesn't exist, append at end
            content += `\n${sectionHeader}\n${entry}`;
          }

          await this.storage.write(historyFile, content);

          return {
            textResultForLlm: `Appended to ${args.agent} history (${args.section})`,
            resultType: 'success',
            toolTelemetry: { agent: args.agent, section: args.section },
          };
        } catch (error) {
          return {
            textResultForLlm: `Failed to update agent memory: ${sanitizeErrorForLlm(error, this.squadRoot)}`,
            resultType: 'failure',
            error: String(error),
          };
        }
      },
    });

    // squad_status: Query session pool state
    const squadStatus = defineTool<StatusQuery>({
      name: 'squad_status',
      description: 'Query the status of active sessions in the pool. Returns session metadata and current state.',
      parameters: {
        type: 'object',
        properties: {
          agentName: {
            type: 'string',
            description: 'Filter by agent name',
          },
          status: {
            type: 'string',
            description: 'Filter by session status (active, idle, completed)',
          },
          verbose: {
            type: 'boolean',
            description: 'Include detailed session metadata',
            default: false,
          },
        },
      },
      handler: async (args) => {
        const pool = this.sessionPoolGetter?.();
        
        if (!pool) {
          return {
            textResultForLlm: 'Session pool not available. Pool size: 0, Active sessions: 0',
            resultType: 'success',
            toolTelemetry: {
              poolAvailable: false,
              totalSessions: 0,
              activeSessions: 0,
            },
          };
        }

        const allSessions = Array.from((pool as any).sessions?.values() || []);
        let filteredSessions = allSessions;

        // Apply agent name filter
        if (args.agentName) {
          filteredSessions = filteredSessions.filter(
            (s: any) => s.agentName === args.agentName
          );
        }

        // Apply status filter
        if (args.status) {
          filteredSessions = filteredSessions.filter(
            (s: any) => s.status === args.status
          );
        }

        const poolInfo = {
          poolSize: pool.size,
          capacity: (pool as any).config?.maxConcurrent || 0,
          atCapacity: pool.atCapacity,
          activeSessions: pool.active().length,
          totalSessions: allSessions.length,
          filteredCount: filteredSessions.length,
        };

        // Build response
        const sessionsByAgent: Record<string, number> = {};
        const sessionsByStatus: Record<string, number> = {};

        for (const session of allSessions) {
          const s = session as any;
          sessionsByAgent[s.agentName] = (sessionsByAgent[s.agentName] || 0) + 1;
          sessionsByStatus[s.status] = (sessionsByStatus[s.status] || 0) + 1;
        }

        let textResult = `Pool status: ${poolInfo.poolSize}/${poolInfo.capacity} sessions (${poolInfo.activeSessions} active)`;
        
        if (args.agentName || args.status) {
          textResult += `\nFiltered results: ${poolInfo.filteredCount} sessions`;
        }

        if (args.verbose && filteredSessions.length > 0) {
          textResult += '\n\nSessions:';
          for (const session of filteredSessions) {
            const s = session as any;
            const uptime = s.createdAt ? Math.floor((Date.now() - s.createdAt.getTime()) / 1000) : 0;
            textResult += `\n- ${s.id.slice(0, 8)}: ${s.agentName} (${s.status}, ${uptime}s uptime)`;
          }
        }

        return {
          textResultForLlm: textResult,
          resultType: 'success',
          toolTelemetry: {
            poolInfo,
            sessionsByAgent,
            sessionsByStatus,
            filters: {
              agentName: args.agentName,
              status: args.status,
              verbose: args.verbose || false,
            },
          },
        };
      },
    });

    // squad_skill: Read/write agent skills
    const squadSkill = defineTool<SkillRequest>({
      name: 'squad_skill',
      description: 'Read or write agent skill definitions. Skills are stored in .squad/skills/{name}/SKILL.md.',
      parameters: {
        type: 'object',
        properties: {
          skillName: {
            type: 'string',
            description: 'Skill name (maps to directory name)',
          },
          operation: {
            type: 'string',
            enum: ['read', 'write'],
            description: 'Operation to perform',
          },
          content: {
            type: 'string',
            description: 'Skill content (required for write)',
          },
          confidence: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Confidence level (required for write)',
          },
        },
        required: ['skillName', 'operation'],
      },
      handler: async (args) => {
        if (!/^[a-zA-Z0-9_-]+$/.test(args.skillName)) {
          return { textResultForLlm: 'Invalid skill name: must contain only letters, numbers, hyphens, and underscores', resultType: 'failure', error: 'Invalid skillName' };
        }
        try {
          const projectRoot = path.dirname(this.squadRoot);
          const legacySkillDir = path.join(this.squadRoot, 'skills', args.skillName);
          const copilotSkillDir = path.join(projectRoot, '.squad', 'skills', args.skillName);
          const skillDir = args.operation === 'write'
            ? copilotSkillDir
            : await this.storage.exists(path.join(copilotSkillDir, 'SKILL.md'))
              ? copilotSkillDir
              : legacySkillDir;
          const skillFile = path.join(skillDir, 'SKILL.md');

          if (args.operation === 'read') {
            const content = await this.storage.read(skillFile);
            if (content === undefined) {
              return {
                textResultForLlm: `Skill not found: ${args.skillName}`,
                resultType: 'failure',
                error: 'Skill file does not exist',
              };
            }

            return {
              textResultForLlm: `Skill: ${args.skillName}\n\n${content}`,
              resultType: 'success',
              toolTelemetry: { skillName: args.skillName, operation: 'read' },
            };
          } else {
            // write operation
            if (!args.content) {
              return {
                textResultForLlm: 'Error: content is required for write operation',
                resultType: 'failure',
                error: 'Missing required field: content',
              };
            }

            const skillContent = [
              `# ${args.skillName}`,
              '',
              `**Confidence:** ${args.confidence || 'medium'}`,
              `**Updated:** ${new Date().toISOString()}`,
              '',
              args.content,
            ].join('\n');

            await this.storage.write(skillFile, skillContent);

            return {
              textResultForLlm: `Skill written: ${args.skillName} (.squad/skills/${args.skillName}/SKILL.md)`,
              resultType: 'success',
              toolTelemetry: { skillName: args.skillName, operation: 'write', confidence: args.confidence },
            };
          }
        } catch (error) {
          return {
            textResultForLlm: `Failed to ${args.operation} skill: ${sanitizeErrorForLlm(error, this.squadRoot)}`,
            resultType: 'failure',
            error: String(error),
          };
        }
      },
    });

    // Register all tools
    this.tools.set('squad_route', squadRoute);
    this.tools.set('squad_decide', squadDecide);
    this.tools.set('squad_memory', squadMemory);
    this.tools.set('squad_status', squadStatus);
    this.tools.set('squad_skill', squadSkill);

    if (this.registryOptions.enableWorkstationTools) {
      for (const tool of createWorkstationTools(this.registryOptions.workstationOptions)) {
        this.tools.set(tool.name, tool);
      }
    }
  }

  /** Get all registered tools for session config */
  getTools(): SquadTool<any>[] {
    return Array.from(this.tools.values());
  }

  /** Get tools filtered by agent's allowed tool list */
  getToolsForAgent(allowedTools?: string[]): SquadTool<any>[] {
    if (!allowedTools) return this.getTools();
    return allowedTools
      .map(name => this.tools.get(name))
      .filter((t): t is NonNullable<typeof t> => t != null);
  }

  /** Get a specific tool by name */
  getTool(name: string): SquadTool<any> | undefined {
    return this.tools.get(name);
  }

  /**
   * Replace built-in tool handlers with skill-backed versions.
   * Called post-construction after SkillScriptLoader has resolved handlers.
   * Only replaces tools that already exist — unknown tool names are silently ignored.
   * Once applied, handlers are immutable for the session.
   *
   * Skill handlers are already OTel-wrapped by SkillScriptLoader.load() — no re-wrapping here.
   */
  applySkillHandlers(tools: SquadTool<any>[]): void {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        this.tools.set(tool.name, tool);
      }
      // Unknown tool names silently ignored — skills cannot introduce new tools
    }
  }
}
