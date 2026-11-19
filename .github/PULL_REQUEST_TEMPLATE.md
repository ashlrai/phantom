<!-- Thanks for contributing to Phantom! Humans and coding agents use the same
     path: see CONTRIBUTING.md and AGENTS.md ("Working in this repository").
     First pull request? docs/CONTRIBUTE-WITH-AN-AGENT.md walks it from fork
     to auto-merge. -->

## What & why

<!-- What does this change and why? Link any issue: Closes #123 -->

## How it was verified

<!-- Tick what you ran; say what you skipped and why. Local checks do not
     replace the required hosted CI (Merge Gate stays the full check). -->

- [ ] `node scripts/verify-changed.mjs` clean (lint of changed files plus one type check; run once, in the foreground)
- [ ] Affected backend tests pass hermetically: `npm run test:ci -- test/<file>.test.ts` (new behavior has tests; no test was weakened or removed)
- [ ] `npm run test:web` if `src/web-ui/` changed
- [ ] `npm run check:docs` if docs changed; `npx vitest run test/doc-facts.test.ts` if a documented command, flag or script changed
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

<!-- Anything reviewers should know: trade-offs, follow-ups, deliberately-deferred items -->
