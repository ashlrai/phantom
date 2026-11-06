# Agent readiness scorer

`scripts/agent-readiness/score.mjs` grades how legible a published site or a
repo checkout is to an autonomous agent. It is fully offline: it reads only
files inside the scored directory, makes no network requests or model calls,
and writes nothing unless asked. The implementation is
[src/core/observability/agent-readiness.ts](../src/core/observability/agent-readiness.ts).

```sh
npm run build   # the script loads dist/
node scripts/agent-readiness/score.mjs --site site/ --repo . --json
```

Targets: `--site DIR` for a built static site, `--repo DIR` for a checkout,
`--target DIR` for auto-detection (a directory with root HTML files is a
site). `--out DIR` overrides the artifact directory; the default is
`$ASHLR_HOME/metrics/agent-readiness/` or `~/.ashlr/metrics/agent-readiness/`,
the same metrics inputs tree the impact reward job reads, so a consumer can
reward readiness gains between runs. `--no-write` scores without writing;
`--json` prints a machine-readable run report. Exit codes: 0 success, 1
unreadable target or malformed existing artifact, 2 usage error.

## Scores

Each target reports a 0..100 score. Every check below contributes
`weight * score` points where `score` is the 0..1 rubric result for that
check. Site targets run all checks; repo targets run the file checks only
(llmsTxt, agentsMd, capabilities, mcpServer; applicable weight 45) and the
total is normalized over the applicable weight, so a checkout is not
penalized for lacking pages.

| Check | Weight | Full credit | Partial credit | Site | Repo |
| --- | ---: | --- | --- | :-: | :-: |
| `llmsTxt` | 15 | `llms.txt` and `llms-full.txt` exist, each with an H1, a `##` section, and 3+ Markdown links | present but thin or missing links | yes | yes |
| `agentsMd` | 10 | `AGENTS.md` (root or `docs/`) of 400+ bytes, 2+ sections, named tooling, build/test guidance | present but thin | yes | yes |
| `jsonLd` | 10 | a named `SoftwareApplication`/`WebApplication`/`MobileApplication` in an `application/ld+json` block | JSON-LD without an application type; unparseable block scores lower | yes | no |
| `sitemapRobots` | 10 | `sitemap.xml` with `<urlset>` or `<sitemapindex>` and `<loc>` entries, plus `robots.txt` declaring `Sitemap:` | sitemap without robots link, or a sitemap with no `<loc>` | yes | no |
| `openGraph` | 10 | every page has `<title>`, meta description, `og:title`, `og:description`, `og:type`, `og:url`, `og:image`, `twitter:card` | mean coverage across pages | yes | no |
| `canonical` | 10 | every page has an absolute `http(s)` `rel=canonical` | relative canonical | yes | no |
| `headings` | 10 | every page has exactly one `h1` and no skipped heading levels | pages without headings are neutral | yes | no |
| `capabilities` | 10 | `capabilities.json` (or `.well-known` variant) with 2+ of name/version/description/capabilities/install/commands/tools | HTML install page with commands, then Markdown install doc | yes | yes |
| `mcpServer` | 10 | `server.json` (or `.well-known/mcp/server.json`) with `namespace/name`, description, version, and packages or remotes | parseable but incomplete; unparseable scores lower | yes | yes |
| `pageWeight` | 5 | every page <= 128 KiB and total tree <= 2 MiB | degrades at 512 KiB per page and 16 MiB total | yes | no |

Scores are deterministic for a given tree: same files in, same numbers out.

## Artifact contract: agent-readiness.v1

One JSON artifact is written per target as `<kind>-<slug>.json` in the output
directory:

```json
{
  "schema": "agent-readiness.v1",
  "generatedAt": "2026-10-26T12:00:00.000Z",
  "target": { "kind": "site", "path": "site/", "label": "site" },
  "score": 85.0,
  "totals": { "earned": 85, "applicable": 100, "possible": 100 },
  "checks": [
    {
      "id": "llmsTxt", "weight": 15, "applicable": true,
      "score": 0, "points": 0,
      "findings": ["llms.txt missing", "llms-full.txt missing"]
    }
  ],
  "previous": null,
  "delta": null
}
```

When an artifact already exists at the destination, the new run records the
stored `score` and `generatedAt` under `previous` and writes the signed score
difference as `delta`. A malformed existing artifact fails the write rather
than being silently replaced. Writes are same-directory temp file plus
rename, so readers never see a truncated artifact.

`parseAgentReadinessArtifact` validates the shape strictly: all ten checks
exactly once, scores within range, ISO timestamps, and the `agent-readiness.v1`
schema tag. Rubric or schema changes require a new schema version and new
tests, matching how the impact reward contract versions its formula.
