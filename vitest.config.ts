import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use node environment for testing
    environment: 'node',

    // Include test files
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],

    // Exclude patterns
    exclude: ['node_modules', 'dist', 'output'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'output/',
        '**/*.test.ts',
        '**/*.spec.ts',
        'src/index.ts', // CLI entry point
      ],
    },

    // Global test timeout
    testTimeout: 10000,

    // Show detailed test output
    reporters: ['verbose'],
  },
});
