# Contributing

## Development setup

Requires Node.js 22.13 or newer (see `.nvmrc`).

```bash
npm ci
npm run dev        # Vite dev server
npm run dev:api    # local API server
```

## Checks

Run the full check before opening a pull request:

```bash
npm run check
```

This builds the project, runs the Vitest suite and the server tests.

## Guidelines

- Code generation changes (`src/codegen.ts`) should include a test in `src/codegen.test.ts`.
- When adding a display driver, update `src/displays.ts` and the README table.
- Keep pull requests focused; use [Conventional Commits](https://www.conventionalcommits.org/).
