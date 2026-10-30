# AGENTS.md: the verse.ashlr.ai site

`site/` is the static source of <https://verse.ashlr.ai>: HTML landing,
ecosystem, install, comparison and use-case pages plus agent-facing manifests
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
- Regenerate `sitemap.xml` with `node scripts/build-site-sitemap.mjs` after
  changing HTML pages; the generator includes the nested pages too.

## Verify

```sh
node scripts/generate-site-llms.mjs --check   # llms files are current
node scripts/build-site-sitemap.mjs --check
HOME=$(mktemp -d) npm run test:ci -- test/site-discoverability.test.ts test/site-ecosystem-smoke.test.ts test/site-seo.test.ts
node scripts/check-documentation.mjs
```

Deploys happen only by merging to `master`; Vercel then publishes `site/` to
verse.ashlr.ai. The existing site smoke lane and the discoverability test are
the pre-merge checks for this directory.
