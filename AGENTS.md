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
- Before a PR: `npm run typecheck`, `npm run lint`, `npm run check:docs`, and the affected tests (`npx vitest run test/<file>.test.ts`, `npm run test:web` for `src/web-ui`). `npm run gate` runs build, static checks and related tests together.
- Layout: `src/cli/` command dispatchers, `src/core/` logic, `src/web-ui/` console, `test/` backend suites (`m<N>.<topic>.test.ts`), `docs/` guides indexed by `docs/README.md`.
- Read next: [docs/AGENT-OPERATIONS.md](docs/AGENT-OPERATIONS.md) (setup and operation), [CONSTITUTION.md](CONSTITUTION.md), [CONTRIBUTING.md](CONTRIBUTING.md).
