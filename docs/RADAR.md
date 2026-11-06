# Docs Radar

Radar records changes to public documentation and package metadata. It makes
read-only HTTPS GET requests without credentials and saves normalized observations
locally. A change is evidence of different source content, not proof that a
feature is available or that a model capability works.

## Commands

Copy and paste:

```sh
phm radar list --json
phm radar run --json
phm radar diff --json
```

`list` validates and displays the catalogue without network access. `run` visits
verified sources sequentially, independently reporting each outcome. Unverified
sources remain visible but are never fetched. `diff` reads local state only and
compares the last two successful observations. The first observation is a
`baseline`, not a report that every entry was newly added.

All verbs accept `--json`. Help supports `phm radar --help --json`. List emits
`{ok,sources}`; run emits `{ok,results,warnings}` and diff emits `{ok,results}`.
A run reports individual fetch or parse failures as warnings and exits 0 unless
every source errors or the catalogue is invalid. Diff reports unavailable, stale
or missing evidence as an error. Invalid arguments exit 2. A throttled run exits 0 and includes `retryAt`; it does
not claim to have refreshed the source.

## Source catalogue

Each entry has exactly `id`, `product`, `url`, `kind`, and `verified`.
Kinds are `page`, `atom`, `rss`, `npm`, `pypi`, or `json`. IDs are unique lowercase
letters, digits and hyphens, up to 80 characters. `verified` is a boolean and
means a maintainer checked the public endpoint, not that the content is trusted.

The catalogue covers Claude, Codex, Grok, Cursor, Devin, GLM, Gemini,
Antigravity, MLX, Qwen, GitHub CLI, Vercel CLI, Supabase CLI, Wrangler,
Context7 and the MCP SDK. Grok Bot and Grok Build use their RSS feeds for
fetching their changelogs.

Only public HTTPS URLs on port 443 are accepted. Credentials, query strings,
fragments, IP literals, local hostnames and extra configuration such as headers
are refused. Runtime DNS answers are checked against private and reserved IPv4
ranges and pinned to the request. IPv4 DNS connectivity is required. Redirects
are refused, including redirects to another public URL; update the catalogue to
the verified final endpoint instead. No auth headers, cookies, proxy credentials,
provider accounts or browser sessions are used. Responses must be HTTP 200 and
uncompressed. The entire read, including DNS, has a 15-second deadline and a
2 MiB body limit. Errors use fixed diagnostics without response bodies.

## Observations and diffs

- Atom: entry IDs and titles, sorted by ID. XML namespaces, character references,
  CDATA and text/HTML/XHTML titles are supported. DTDs, duplicate IDs, malformed
  feeds and entries without identity/title are refused. Diffs report added and
  removed IDs and changed titles. Removal means absence from this fetched feed
  window, not deletion from the provider's complete history.
- RSS 2.0: item GUIDs, or links when GUIDs are absent, and titles. The same
  XML safety rules and added, removed and changed title diffs apply as for Atom.
- npm: `dist-tags.latest`, or `version` for a version-specific endpoint.
- PyPI: `info.version`.
- Page: SHA-256 of whitespace-normalized visible text and an ordered heading
  list. Scripts, styles, comments and tag markup are excluded. Common and numeric
  character references are decoded. This is a static HTML observation, with no
  browser execution or JavaScript-rendered content.
- JSON: SHA-256 of canonical JSON with sorted object keys and preserved array
  order. Unrelated key ordering does not trigger a change.

No raw page body is retained. Remote text is untrusted data; it never becomes
instructions, queued work, routing changes, notifications or outbound messages.
Machine output escapes source text as JSON, following the offline modelcaps
report's approach. Existing `scripts/radar-modelcaps.ts` remains an independent,
offline comparison of complete model inventories. Ecosystem changelog collection
and curated cross-repository links remain separate evidence streams.

## Storage and recovery

State lives at `~/.phantom/radar/snapshots/<id>.json`, with directory creation mode
0700 and atomic file writes at mode 0600. Symlinked directories or state files
are refused. A file contains the latest attempt time, the last two successful
snapshots, and a failure marker. Failed fetches or normalization leave successful
observations intact and mark subsequent local diffs `stale`.

Every source attempt is recorded before network access. A source cannot run
again for six hours, including after failures or an interrupted attempt. A clock
rollback conservatively extends the wait. There is no force or cooldown-bypass
flag. Changing the source URL or kind under an existing ID refuses comparison;
use a new ID to establish a new baseline.

An exclusive `<id>.lock` prevents concurrent runs. A normal exit removes it. If
a process crashes, the lock remains and reports `busy`. Its local JSON records
`pid` and `startedAt`. Confirm that process has exited before removing that one
lock file. Do not remove snapshot JSON to bypass the cooldown. Corrupt state is
reported as an error rather than silently reset to an empty successful baseline.

## Offline verification

All test responses are synthetic. With a temporary test home:

```sh
HOME=$(mktemp -d) npx vitest run test/radar-sources.test.ts test/radar-diff.test.ts test/radar-cli.test.ts test/radar-modelcaps.test.ts --bail 1
```
