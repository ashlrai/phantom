# AGENTS.md: agent constitution

This repository is part of the AshlrAI ecosystem. It is maintained by Phantom (`phm improve` / steward) and other coding agents, under the same standing authority that applies to `ashlrai/phantom` (see phantom `docs/STANDING-AUTHORITY.md`).

## Tools for agents working here
- This repo's `.mcp.json` declares Phantom's companion MCP servers (Phantom Secrets, Locus, Lexicon, Stack). What each is for, its limits, and how to approve it: [docs/AGENT-TOOLCHAIN.md](docs/AGENT-TOOLCHAIN.md).
- In a Phantom cloud task, list the companion tools you actually called in the report's `toolsUsed` field (an empty list if none); `phm cloud list` shows it as the session's claim.

## Agents may
- Create branches, commit, and open pull requests.
- Turn on GitHub auto-merge (`gh pr merge --auto`; `phm improve propose` opens draft PRs only and refuses `--auto-merge`). A PR merges only after every required CI check is green. Never bypass a failing or pending check, and never use an admin override.
- Fix CI, tests, docs, and dependencies, and iterate on review feedback.

## Reserved for Mason (owner approval required)
- Creating, moving, or deleting release tags, and publishing packages or releases.
- Rotating, creating, or exposing secrets and tokens.
- Deleting repositories, branches, or data, and changing rulesets or branch protection.
- Spending money, or anything that is billed.
- Outside messages: emails, posts, issues, or comments directed at people outside AshlrAI.

## Ground rules
- Keep diffs small and reviewable, with one concern per PR.
- Never commit secrets. Use Phantom Secrets placeholders.
- Never force-push to the default branch.

## Working in this repository
- Node `>=22.15.0`. Install with `npm ci`, build with `npm run build`, run the CLI from source with `npm run dev -- <command>`.
- Backend tests: `npm test` for all backend suites, or `npm run test:ci -- test/<file>.test.ts` for affected suites with the hermetic runner. Run tests with a temporary HOME, for example `HOME=$(mktemp -d) npm run test:ci -- test/agents-md-audit.test.ts`.
- Before a PR: `npm run typecheck`, `npm run lint`, `npm run check:docs`, and the affected tests (`npm run test:ci -- test/<file>.test.ts`, `npm run test:web` for `src/web-ui`). `npm run gate` runs build, static checks and related tests together. Its import graph cannot select tests that read changed files as text; run those test files explicitly. Local checks do not replace required hosted CI.
- Layout: `src/cli/` command dispatchers, `src/core/` logic, `src/web-ui/` console, `test/` backend suites (`m<N>.<topic>.test.ts`), `docs/` guides indexed by `docs/README.md`.
- Read next: [docs/AGENT-OPERATIONS.md](docs/AGENT-OPERATIONS.md) (setup and operation), [CONSTITUTION.md](CONSTITUTION.md), [CONTRIBUTING.md](CONTRIBUTING.md).

## Coding and verification conventions

- Use TypeScript with ESM imports. Keep CLI dispatch in `src/cli/` thin and implementation logic in `src/core/`; follow nearby modules and [CONTRIBUTING.md](CONTRIBUTING.md).
- Keep backend tests in `test/` and web component tests beside their components. Add regression coverage for changed behavior; never weaken a test or security control to pass a check.
- Do not read or print real credentials, environment dumps, or secret values. Use Phantom Secrets references and Locus for scoped account access; see [the toolchain guide](docs/AGENT-TOOLCHAIN.md).
- Report the exact commands run, failures and remaining limitations. Keep documentation commands aligned with [package.json](package.json); the [AGENTS.md audit](docs/AGENTS-MD-AUDIT.md) records public-source gaps across the seven repos.

## Onboarding the ecosystem (agents)

1. Call MCP `ashlr_ecosystem_status` (or `ashlr ecosystem status --json`). If `ready` is true, start work.
2. Otherwise call `ashlr_ecosystem_up` (or `ashlr ecosystem up --json --no-clone` if you must not clone). It clones, enrolls and enables the steward schedule.
3. If `steps[].grant` is `waiting-on-you`, stop and tell the human to run `nextCommand` (`ashlr ecosystem up`) in their own terminal. Never try to sign, edit or work around the standing grant.
4. Apply each `repos[].fixes[].command` only if it is within your grant; CI-gate and ruleset fixes are reserved for the human.
See docs/ECOSYSTEM-ONBOARDING.md.
