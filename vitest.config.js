import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: [
      '**/node_modules/**',
      // Archived pre-hardening snapshot. These tests import server modules from a
      // directory that was intentionally "removed from public" and are not part of
      // the active test suite.
      '**/_p0_hardening_removed_from_public/**',
    ],
  },
});
