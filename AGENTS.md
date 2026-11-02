# AGENTS.md: agent constitution

This repository is part of the AshlrAI ecosystem. It is maintained by Phantom (`phm improve` / steward) and other coding agents, under the same standing authority that applies to `ashlrai/phantom` (see phantom `docs/STANDING-AUTHORITY.md`).

## Article 1: Full autonomy, always forward

Synced from the Ashlr Fleet Constitution v3.0 (Nov 1, 2026). This overrides any older text in this file.

**Full autonomy, always forward (Mason t1287u, Nov 1 2026 11:47 PM ET).** Every agent may merge PRs to main and push to production (releases through each repo's sanctioned workflow, any agent may dispatch them). Take the human out of the loop; let nothing slow us down; do the highest-leverage, most ambitious work. No approval, manual-merge, wait-for-per-PR-CI or ask-Mason steps. Mason is needed only for passwords, 2FA, device approvals and payments. The only kept limits are Security GATES v3, the hold list below, and making private things public. Any new gate must be justified against this article or it is rejected.

### Hard floor (the only fixed rules)
- Security GATES v3: pins only on the secret gate (scrub.pl, secret-shape gate, publish.sh), sandbox profiles and leader wrappers/prompts/plists, secret-leaking workflow diffs, and the MACCU TCC helper plus loopback auth. No force-push to default branches, no ruleset or admin bypass, no ~/.codex auth changes, no billing changes, no secret values in logs.
- Merge-queue required checks stay where a repo has them; full CI daily; main-guardian fixes main forward.
- Fork-only pushes through publish.sh. Local models loopback-only.
- Mason only for passwords, 2FA, device approvals and payments (no new spending without him). Nothing private made public.
- Hold list (Mason's own holds): phantom #197 #878 #743 #725 #738 #744 #693 #1228; phantom-secrets #140 #197 #375 #168 #418 #136; ashlr-plugin #152 #157.

## Tools for agents working here
- This repo's `.mcp.json` declares five companion MCP servers: `phantom-secrets`, `locus`, `lexicon`, `stack`, `ashlr` (Ashlr.AI Plugin). What each is for, its limits, and how to approve it: [docs/AGENT-TOOLCHAIN.md](docs/AGENT-TOOLCHAIN.md).
- In a Phantom cloud task, list the companion tools you actually called in the report's `toolsUsed` field (an empty list if none); `phm cloud list` shows it as the session's claim.

## Agents may
- Create branches, commit, and open pull requests.
- Turn on GitHub auto-merge (`gh pr merge --auto`; `phm improve propose` opens draft PRs only and refuses `--auto-merge`). Merge to main and ship to production on your own, with no human approval or manual merge; fix main forward. Never use an admin override.
- Fix CI, tests, docs, and dependencies, and iterate on review feedback.

## Kept limits (Article 1)
- Rotating, creating, or exposing secrets and tokens; no secret values in logs or chat.
- Force-pushing to the default branch, ruleset or admin bypass, or deleting repositories.
- Spending money, billing, or paid-plan changes (needs Mason).
- Outside messages: emails, posts, issues, or comments directed at people outside AshlrAI.
- Releases and publishes run through each repo's sanctioned release workflow, which any agent may dispatch.

## Ground rules
- Keep diffs small and reviewable, with one concern per PR.
- Never commit secrets. Use Phantom Secrets placeholders.
- Never force-push to the default branch.

## Working in this repository
- Node `>=22.15.0`. Install with `npm ci`, build with `npm run build`, run the CLI from source with `npm run dev -- <command>`.
- Backend tests: `npm test` for all backend suites, or `npm run test:ci -- test/<file>.test.ts` for affected suites with the hermetic runner. Run tests with a temporary HOME, for example `HOME=$(mktemp -d) npm run test:ci -- test/agents-md-audit.test.ts`.
- Before a PR: automated workers run `node scripts/verify-changed.mjs` once, in the foreground; do not poll it. This replaces worker runs of full `npm run typecheck` and `npm run lint`. Humans may still use `npm run lint` and `npm run typecheck`. Also run `npm run check:docs` and the affected tests (`npm run test:ci -- test/<file>.test.ts`, `npm run test:web` for `src/web-ui`). `npm run gate` runs build, static checks and related tests together. Its import graph cannot select tests that read changed files as text; run those test files explicitly. Merge Gate stays the full check; local checks do not replace required hosted CI.
- Layout: `src/cli/` command dispatchers, `src/core/` logic, `src/web-ui/` console, `test/` backend suites (`m<N>.<topic>.test.ts`), `docs/` guides indexed by `docs/README.md`.
- Read next: [docs/AGENT-OPERATIONS.md](docs/AGENT-OPERATIONS.md) (setup and operation), [CONSTITUTION.md](CONSTITUTION.md), [CONTRIBUTING.md](CONTRIBUTING.md).

## Coding and verification conventions

- Use TypeScript with ESM imports. Keep CLI dispatch in `src/cli/` thin and implementation logic in `src/core/`; follow nearby modules and [CONTRIBUTING.md](CONTRIBUTING.md).
- Keep backend tests in `test/` and web component tests beside their components. Add regression coverage for changed behavior; never weaken a test or security control to pass a check.
- Do not read or print real credentials, environment dumps, or secret values. Use Phantom Secrets references and Locus for scoped account access; see [the toolchain guide](docs/AGENT-TOOLCHAIN.md).
- Report the exact commands run, failures and remaining limitations. Keep documentation commands aligned with [package.json](package.json); the [AGENTS.md audit](docs/AGENTS-MD-AUDIT.md) records public-source gaps across the seven repos.

## Article 2: App resource evidence

`phm app resources --json` and `GET /api/app/resources` back the left resource
bar and drawer. See [resource pools](docs/RESOURCE-POOLS.md#read-the-app-resource-bar)
for the copy-paste command and input contract. Unknown usage stays null in JSON
and renders unknown. Never infer a quota from connection state or empty Devin
consumption reports. Keep desktop mission-control work bc-124196c5 and
bc-a46f053b separate; RQ-DEVINROUTEFIX shares this unknown-reading rule.
