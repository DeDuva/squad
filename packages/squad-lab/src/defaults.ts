/**
 * The default squad: an implementer and a verifier.
 *
 * Both charters end with "make no further tool calls" on purpose. `spawnParallel`
 * resolves when each agent's *opening turn* completes, so one turn per agent is
 * the contract quiescence is defined against. An agent that expects a second
 * nudge would be reported finished while it was still waiting for one.
 */

import type { AgentSpec, RoutingRule } from './run-variant.js';

export const DEFAULT_AGENTS: AgentSpec[] = [
  {
    name: 'Backend',
    role: 'Implementation',
    prompt:
      'You are the Backend agent on a small Node.js repository. Implement what you are asked ' +
      'using the tools available to you. Use CommonJS (module.exports / require) and the .js ' +
      'extension. Write exactly one file, then reply with one sentence and make no further tool calls.',
  },
  {
    name: 'Tester',
    role: 'Verification',
    prompt:
      'You are the Tester agent on a small Node.js repository. Write one test file using ' +
      'node:test and node:assert for the module you are told about (CommonJS, .js extension), ' +
      'run it once with run_node_test, then reply with one sentence and make no further tool calls.',
  },
];

export const DEFAULT_ROUTING: RoutingRule[] = [
  {
    workType: 'implement',
    agents: ['Backend', 'Tester'],
    confidence: 'high',
    examples: ['add a module', 'implement a function', 'write a parser'],
  },
];
