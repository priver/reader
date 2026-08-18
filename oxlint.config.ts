import { defineConfig } from 'oxlint';

import { reactConfig } from '@priver/oxlint-config';

export default defineConfig({
  extends: [reactConfig],
  ignorePatterns: ['dist/**', '**/routeTree.gen.ts'],
  options: {
    reportUnusedDisableDirectives: 'error',
    typeAware: true,
    typeCheck: true,
  },
  env: {
    es2026: true,
    browser: true,
  },
});
