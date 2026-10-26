# AGENTS.md: the verse.ashlr.ai site

`site/` is the static source of <https://verse.ashlr.ai>: three HTML pages
(`index.html`, `ecosystem.html`, `install.html`) plus agent-facing manifests
(`llms.txt`, `llms-full.txt`, `capabilities.json` and
`.well-known/mcp/server.json`). There is no framework, build step or server
side; Vercel serves this directory as-is (see `vercel.json` at the repository
root). The product's own constitution is
[AGENTS.md](../AGENTS.md) at the repository root.

## Rules for edits

- Keep every claim aligned with what the software does today. `site/README.md`
  records the evidence behind each number on the page.
- Every page needs exactly one `h1`, semantic heading order (no skipped
  levels), one absolute `rel=canonical`, a meta description, OpenGraph tags
  and a `twitter:card`.
- `llms.txt` and `llms-full.txt` are generated from `README.md` and `docs/`
  headings. After changing either source, run
  `node scripts/generate-site-llms.mjs`; `--check` fails when they drift.
- Version fields in `capabilities.json`, `.well-known/mcp/server.json` and the
  pages' JSON-LD describe the last verified published release, never a
  candidate that `scripts/sync-candidate-version.mjs` has not released.
- No telemetry, forms, credentials or provider calls. Documentation links use
  `https://github.com/ashlrai/phantom/blob/master/...` URLs.

## Verify

```sh
node scripts/generate-site-llms.mjs --check   # llms files are current
npx vitest run test/site-discoverability.test.ts
npx vitest run test/site-ecosystem-smoke.test.ts
node scripts/check-documentation.mjs --root . --mode source
```

Deploys happen only by merging to `master`; Vercel then publishes `site/` to
verse.ashlr.ai. The existing site smoke lane and the discoverability test are
the pre-merge checks for this directory.
