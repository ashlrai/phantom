# AGENTS.md: agent constitution

This repository is part of the AshlrAI ecosystem. It is maintained by Phantom (`phm improve` / steward) and other coding agents, under the same standing authority that applies to `ashlrai/phantom` (see phantom `docs/STANDING-AUTHORITY.md`).

## Agents may
- Create branches, commit, and open pull requests.
- Turn on GitHub auto-merge (`phm improve --auto-merge` / `gh pr merge --auto`). A PR merges only after every required CI check is green. Never bypass a failing or pending check, and never use an admin override.
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

## Onboarding the ecosystem (agents)

1. Call MCP `ashlr_ecosystem_status` (or `ashlr ecosystem status --json`). If `ready` is true, start work.
2. Otherwise call `ashlr_ecosystem_up` (or `ashlr ecosystem up --json --no-clone` if you must not clone). It clones, enrolls and enables the steward schedule.
3. If `steps[].grant` is `waiting-on-you`, stop and tell the human to run `nextCommand` (`ashlr ecosystem up`) in their own terminal. Never try to sign, edit or work around the standing grant.
4. Apply each `repos[].fixes[].command` only if it is within your grant; CI-gate and ruleset fixes are reserved for the human.
See docs/ECOSYSTEM-ONBOARDING.md.
