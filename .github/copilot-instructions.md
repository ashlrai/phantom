# GitHub Copilot instructions

[AGENTS.md](AGENTS.md) is the canonical brief for every coding agent working in `phantom` (Codex, Claude Code, Cursor, GitHub Copilot, Gemini CLI, Grok, Devin, Aider, Windsurf, or a local model). Read it before changing anything; it wins over this file if they ever disagree.

Quick reference (details and exceptions live in AGENTS.md and CONTRIBUTING.md):

- Toolchain: Node >=22.15
- Setup: `npm ci`
- Test: `npm test` (or `npm run test:ci -- test/<file>.test.ts` for one suite)
- Before opening a PR: `node scripts/verify-changed.mjs`
- Open a focused PR against the default branch; never force-push shared branches or bypass required checks.
- Fill in the optional "Agent used" line in the PR template so maintainers can see which tools contribute.
- Never commit secrets, tokens or personal data.
