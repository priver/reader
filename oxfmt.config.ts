import { defineConfig } from 'oxfmt';

export default defineConfig({
  ignorePatterns: [
    '**/*.html',
    'pnpm-lock.yaml',
    '.agents/skills/',
    'apps/reader/src/routeTree.gen.ts',
  ],
  singleQuote: true,
  quoteProps: 'consistent',
  proseWrap: 'always',
  jsdoc: true,
  sortImports: {
    ignoreCase: false,
    internalPattern: ['@priver/'],
    groups: [
      'builtin',
      'external',
      'internal',
      'subpath',
      ['parent', 'sibling', 'index'],
      'style',
      'unknown',
    ],
  },
  sortTailwindcss: {
    stylesheet: './packages/ui/src/style.css',
    functions: ['cva', 'cx'],
  },
  overrides: [
    {
      files: ['**/CHANGELOG.md', '.changeset/*.md'],
      options: {
        proseWrap: 'preserve',
      },
    },
  ],
});
