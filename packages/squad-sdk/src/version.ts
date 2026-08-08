/**
 * The SDK's own version, and nothing else.
 *
 * This module exists so that asking "which SDK produced this run?" does not
 * require importing the root barrel. The barrel re-exports the whole public
 * API, coordinator included, which makes it a coordinator vector — duva-bench
 * forbids importing it (PLAN §0.9) precisely so that a benchmark arm cannot
 * reach the orchestrator by accident.
 *
 * That left recording the harness digest stuck: the digest folds `sdkVersion`,
 * and the only way to read it was through the thing the boundary forbids. A
 * narrow subpath resolves it without weakening the rule, the same way
 * `harnesses/native.ts` did for the squad-native arm.
 *
 * **Keep this module import-free.** Its whole value is that importing it can
 * pull in nothing else; a single import here would quietly re-open the vector
 * it was written to close.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION: string = pkg.version;
