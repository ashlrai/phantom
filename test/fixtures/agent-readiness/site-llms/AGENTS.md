# Acme Widget agent guide

## What this is

Acme Widget formats widget manifests for humans and agents. This file tells
agents how to build, test and run it, and which conventions to keep when
proposing changes.

## Commands

- Install: `npm install -g acme-widget`
- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`

## Conventions

Manifests are JSON. Keep diffs small and run the test suite before pushing.
Manifest fields are sorted; the formatter prints the canonical ordering.
