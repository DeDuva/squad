import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// Load package.json exports maps so we can redirect subpath imports to
// this worktree's own dist/ rather than the parent repo's via node_modules
// symlinks. This ensures vi.mock relative-path stubs intercept imports and
// that init + upgrade both use the same templates directory.
const sdkPkg = JSON.parse(
  readFileSync(path.resolve(__dirname, 'packages/squad-sdk/package.json'), 'utf-8')
) as { exports: Record<string, { import?: string }> };

const cliPkg = JSON.parse(
  readFileSync(path.resolve(__dirname, 'packages/squad-cli/package.json'), 'utf-8')
) as { exports: Record<string, { import?: string }> };

const sdkRoot = path.resolve(__dirname, 'packages/squad-sdk');
const cliRoot = path.resolve(__dirname, 'packages/squad-cli');

export default defineConfig({
  plugins: [
    {
      // Redirect @deduvafork/squad-sdk/* and @deduvafork/squad-cli/* imports
      // to the worktree's local dist/ artifacts. This ensures:
      // 1. vi.mock relative-path stubs intercept SDK imports in adapter tests
      // 2. runInit and runUpgrade both use the worktree's getTemplatesDir(),
      //    so the installed files and the comparison templates are identical.
      name: 'worktree-package-redirect',
      enforce: 'pre' as const,
      resolveId(id: string) {
        if (id === '@deduvafork/squad-sdk') {
          return path.join(sdkRoot, 'dist/index.js');
        }
        if (id.startsWith('@deduvafork/squad-sdk/')) {
          const subpath = id.slice('@deduvafork/squad-sdk/'.length);
          const entry = sdkPkg.exports[`./${subpath}`] as any;
          if (entry?.import) return path.join(sdkRoot, entry.import);
        }
        if (id === '@deduvafork/squad-cli') {
          return path.join(cliRoot, 'dist/cli/index.js');
        }
        if (id.startsWith('@deduvafork/squad-cli/')) {
          const subpath = id.slice('@deduvafork/squad-cli/'.length);
          const entry = cliPkg.exports[`./${subpath}`] as any;
          if (entry?.import) return path.join(cliRoot, entry.import);
        }
      },
    },
  ],
  resolve: {
    // Force a single copy of each package to prevent mock mismatches when
    // both the root and packages/squad-cli/node_modules carry a copy.
    dedupe: ['@deduvafork/squad-sdk', '@deduvafork/squad-cli'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/node_modules/**'],
    },
  },
});
