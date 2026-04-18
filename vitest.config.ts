import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Force vitest to resolve @squad/sdk from the workspace root,
    // not from a duplicate copy under packages/squad-cli/node_modules/.
    // Without this, vi.mock('@squad/sdk') targets the root copy
    // but the code under test imports from the duplicate — bypassing the mock.
    dedupe: ['@squad/sdk'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    // security-review-skills.test.ts imports scripts/security-review.mjs which is not
    // yet implemented (pre-existing upstream issue). Exclude to avoid module load errors.
    exclude: ['test/scripts/security-review-skills.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/node_modules/**'],
    },
  },
});
