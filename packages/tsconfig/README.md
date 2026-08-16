# @priver/tsconfig

Shared TypeScript configurations for the monorepo.

## Configurations

- `@priver/tsconfig` - Base configuration with strict type checking
- `@priver/tsconfig/library` - For libraries (declarations, composite mode)
- `@priver/tsconfig/react` - React support (JSX, DOM types)
- `@priver/tsconfig/vite` - Vite bundler support

## Usage

### Basic setup

```json
{
  "extends": "@priver/tsconfig",
  "include": ["src/**/*", "*.config.ts"]
}
```

### With Vite and React

```json
{
  "extends": ["@priver/tsconfig", "@priver/tsconfig/vite", "@priver/tsconfig/react"],
  "include": ["src/**/*", "*.config.ts"]
}
```

### For libraries

Development config (`tsconfig.json`):

```json
{
  "extends": "@priver/tsconfig",
  "include": ["src/**/*", "*.config.ts"]
}
```

Build config (`tsconfig.build.json`):

```json
{
  "extends": ["@priver/tsconfig", "@priver/tsconfig/library"],
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```
