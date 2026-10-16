# Phantom: Claude Code guide

Phantom (`@ashlr/phantom`) is a TypeScript (Node `>=22.15.0`, ESM) engineering
agent workbench. Its CLI ships as `phm`, with `ashlr` as a compatible alias.

Read first, in this order:
- [AGENTS.md](AGENTS.md): the agent constitution (what agents may do, what is
  reserved for the owner) and its "Working in this repository" section.
- [docs/AGENT-OPERATIONS.md](docs/AGENT-OPERATIONS.md): setup and operation.
- [CONTRIBUTING.md](CONTRIBUTING.md): conventions, tests, contracts.
- [CONSTITUTION.md](CONSTITUTION.md).

## Commands

```bash
npm ci                    # install
npm run build             # full build to dist/
npm run dev -- <command>  # run the CLI from source
npm run typecheck         # tsc --noEmit plus the web typecheck
npm run lint              # eslint plus lane lints
npm run check:docs        # documentation link and anchor check
npx vitest run test/<file>.test.ts   # one backend suite
npm run test:web          # src/web-ui suites
npm run test:ci           # backend lanes with isolated HOME/ASHLR_HOME
npm run gate              # build, static checks and related tests together
```

## Rules

- Tests are hermetic: never read, write or assert against the real home
  directory or real model endpoints. Use temp dirs, injected config and
  `test/fixtures/`. `test/setup/home.ts` relocates HOME and ASHLR_HOME, and
  `test/setup/home-isolation-guard.ts` fails any test that writes under the
  real `~/.ashlr`.
- `src/cli/` handlers stay thin (parse argv, delegate) and logic lives in
  `src/core/`. Relative imports end in `.js` (NodeNext).
- Contract first: changing an exported signature means updating `CONTRACT.md`
  or the matching `docs/contracts/CONTRACT-M<N>.md` in the same change.
- Do not add runtime dependencies casually (see CONTRIBUTING.md).
- When running the CLI by hand, prefer `--help` with HOME set to a scratch
  directory; many commands act on `~/.ashlr`.
