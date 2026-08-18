import config from '@priver/oxfmt-config';
import { defineConfig } from 'oxfmt';

export default defineConfig({
  ...config,
  ignorePatterns: ['**/*.html', 'pnpm-lock.yaml', '**/routeTree.gen.ts'],
  sortTailwindcss: {
    stylesheet: './apps/reader/src/style.css',
    functions: ['cva', 'cx'],
  },
});
