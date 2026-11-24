<!-- Thanks for contributing to Phantom! Humans and coding agents use the same
     path: see docs/CONTRIBUTE-WITH-AN-AGENT.md, CONTRIBUTING.md and AGENTS.md
     ("Working in this repository").
     PRs land as squash commits, so the PR title becomes the commit subject on
     master: give it a conventional prefix such as `fix:` or `docs:`. -->

## What & why

<!-- What does this change and why? Link any issue: Closes #123 -->

## How it was verified

<!-- Tick what you ran; say what you skipped and why. Local checks do not
     replace Merge Gate, the one required hosted check. On a pull request it
     runs the secret scans, the generated-files check and the fast gate
     (type check plus tests selected from your diff); the full suites run on
     the scheduled master run. See "What CI requires" in the contribute guide:
     https://github.com/ashlrai/phantom/blob/master/docs/CONTRIBUTE-WITH-AN-AGENT.md#6-what-ci-requires -->

- [ ] `node scripts/verify-changed.mjs` clean (lint of changed files, one type check, plus the docs and quarantine checks when the diff selects them; run once, in the foreground)
- [ ] Affected backend tests pass hermetically: `npm run test:ci -- test/<file>.test.ts` (new behavior has tests; no test was weakened or removed)
- [ ] `npm run test:web` if `src/web-ui/` changed
- [ ] `npm run check:docs` if docs changed; `npx vitest run test/doc-facts.test.ts` if a documented command, flag or script changed
- [ ] `node scripts/generate-docs-llms.mjs` leaves the tree unchanged if a doc's title or opening line changed (Merge Gate checks this)
- [ ] Any added `.skip`/`.todo` has a live row in `queue/quarantine.tsv` and `npm run check:quarantine -- --base origin/master` passes (Merge Gate does not run this)
- [ ] `npm run build` succeeds if build, packaging or CLI wiring changed
- [ ] `phm verify-safety` still passes if safety-relevant code changed

## Safety invariants (see CONTRIBUTING.md)

- [ ] None of the [safety invariants](https://github.com/ashlrai/phantom/blob/master/CONTRIBUTING.md#safety-invariants-contributors-must-never-weaken) is weakened: enrollment gate, kill-switch, sandboxed engines with diff-only capture, blocked sandbox push, signed provenance, merge policy
- [ ] No secret values, tokens or personal absolute paths in code, logs, docs or this PR
- [ ] Exported signature changes update `CONTRACT.md` or the matching `docs/contracts/CONTRACT-M<N>.md`
- [ ] If authority drift failed, `npm run authority:regen` was run and each new Tier-1 root is listed below for CODEOWNERS review

## Dependencies

- [ ] No new runtime dependency, or the [dependency boundary](https://github.com/ashlrai/phantom/blob/master/CONTRIBUTING.md#dependency-boundary) was updated together with the manifest, lockfile and inventory

## Notes

<!-- Anything reviewers should know: trade-offs, follow-ups, deliberately-deferred items.
     A diff that touches a CODEOWNERS path waits for the owner even after
     Merge Gate passes: https://github.com/ashlrai/phantom/blob/master/docs/CONTRIBUTE-WITH-AN-AGENT.md#protected-paths-wait-for-the-owner -->

## Agent used (optional)

<!-- Helps us learn which coding tools contribute. Leave blank for a fully human PR.
     Examples: Codex, Claude Code, Cursor, GitHub Copilot, Gemini CLI, Grok, Devin, Aider, Windsurf, local model (name it). -->

Agent used:
