# Agent guide

## Project

Widget tools for manifest formatting. TypeScript, ESM, Node 22. The package
publishes a CLI and a small library surface for embedding in agent flows.

## Commands

- Install: `npm ci`
- Build: `npm run build`
- Test: `npx vitest run`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`

## Conventions

- Relative imports end in `.js`.
- Tests are hermetic and use temp dirs.
- Keep diffs small; one concern per change.
