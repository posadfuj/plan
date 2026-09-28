import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**'],
      exclude: ['**/*.test.ts'],
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/*.int.test.ts', 'apps/**/*.int.test.ts'],
          exclude: ['**/node_modules/**'],
          globalSetup: ['./scripts/test-global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
