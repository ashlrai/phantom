# Commit-pinned system map

The system map is a local, model-free view of an enrolled repository. It is a
source navigation aid, not a runtime trace, a test-coverage report, or proof
that an integration is active. It does not need DeepWiki, credentials, or a
network connection.

```sh
phm wiki map --json
phm wiki map phantom --focus 'module:Memory and knowledge' --json
phm wiki map phantom --focus src/cli/wiki.ts --json
```

Omit the repository from its enrolled checkout, or select it by enrolled path
or unique name. Start with the module overview, focus a module to see files,
then focus an exact repo-relative file or a returned node ID to see symbols
and related imports. The native MCP tool `phm_wiki_map` takes a required
`repo` (wiki key or unique enrolled basename, never a path) and optional
`focus`. It returns the same `phantom.wiki.map.v1` JSON as the CLI.

Every node and edge has an `anchor` with `commit`, repo-relative `file`, and
one-based `line`. A module anchors to its first indexed file. A `contains`
edge anchors to its child. An `imports` edge anchors to the first statically
matched occurrence of a local import; overview edges also include the number
of matching file/specifier relationships between the modules. Open anchors
at that commit, not at whatever happens to be in your working tree.

## Freshness and limits

- A cold query lists the captured HEAD tree. A changed HEAD uses a raw Git
  diff from the cached commit and parses only new blob/grammar pairs. Deletes
  remove facts; unchanged importers are re-resolved against the new path set.
  An unchanged HEAD parses no source. If Git cannot diff from the previous
  commit, the index can recover from the target tree and reuse known blobs.
- Files come from Git objects, not the worktree or index. Even the optional
  `ignorePaths` in `.ashlr/wiki.json` comes from the pinned tree. The
  private cache under `~/.ashlr/knowledge/wiki/` stores structural metadata,
  not source bodies. Uncommitted and untracked changes do not affect it.
- `status: "current"` means the response matches the commit captured for
  this query. On refresh failure, `status: "unavailable"` reports the
  requested and last indexed commits when known, without serving stale
  anchors. `not-found` means the focus was not indexed. The CLI exits 0 for
  current, 1 for unavailable/not found, and 2 for bad usage.
- The first extractor covers JavaScript and TypeScript files, named
  top-level declarations, literal local imports/re-exports, Phantom’s CLI
  dispatch and MCP declaration patterns, literal HTTP registrations, and test
  paths. It does not follow dynamic names, infer call graphs, discover tests
  at runtime, or analyze all language/framework patterns. Phantom’s overview
  groups paths into named subsystems; other repos use directory groups.
- Coverage counters report indexed, ignored, skipped and limited files and
  unresolved local imports. Oversized, binary and empty files cannot supply an
  anchor. Query replies are capped at 80 nodes, 120 edges and 24 KiB, with
  `truncated` set when eligible response rows are omitted. Focus a narrower
  node or file when the overview cuts off. `update` reports the refresh mode
  and how many blobs were examined and file fact sets parsed.

The map complements the generated [Repo Wiki and DeepWiki grounding](DEEPWIKI.md),
the [source guide](CODEMAP.md), and [fleet/task graph context](GRAPH-CONTEXT-CHOICES.md).
The interactive desktop view is a separate slice.

## Wiki Brain: evidence links

```sh
phm wiki brain phantom --focus file:src/cli/wiki.ts --json
phm wiki brain phantom --link file:src/cli/wiki.ts --source-kind decision \
  --source-id fleet:decision-123 --source-digest "$SOURCE_SHA256" --json
```

`phm_wiki_brain` is the read-only MCP equivalent. It accepts the same enrolled
repo selector as `phm_wiki_map` and an optional exact node ID as `focus`.
Both reads return `phantom.wiki.brain.v1` evaluated at the captured HEAD.
The private per-checkout store under `~/.ashlr/knowledge/wiki/` holds links to
existing evidence, not copies of source records or their text.

Use `--link` locally to attach a `decision`, `lesson`, `pr`, `failure`, or
`owner-direction` receipt. Pass a namespaced record ID and the lowercase
SHA-256 digest of the exact source record you reviewed. This is a curated
assertion, not independent verification of the source record or approval to
act. The target must exist in the committed map. File/test, symbol, CLI, route,
and MCP node IDs are supported; subsystem roll-ups are not. Replay at the
same commit is idempotent.

Each link carries its target's file and line at the observed commit, the
source kind, ID, and digest, and a target staleness verdict:

| Verdict | Meaning |
| --- | --- |
| `valid` | The observed commit is an ancestor (or the same commit), and the target's file blob is unchanged. |
| `target-changed` | The exact node ID still resolves, but its file blob changed. |
| `target-removed` | The node no longer resolves in the mapped tree. A rename is not automatically relinked. |
| `unknown-ancestry` | Git cannot prove ancestry or read the target revision; unrelated histories and missing objects are not treated as current. |

Reads return up to 24 links and 24 KiB with a `truncated` flag. Focus an exact
node ID for a narrower result. No dirty worktree content is read. Staleness
does not re-verify the evidence source or infer whether the old advice is
still correct.

**After merge:** Cloud's direct PR tracker writes only after it matches
the repository, PR, head and base refs on GitHub, reads the merge SHA and
persists the terminal state. It projects the first-parent diff of that local
Git commit to up to 32 surviving, indexed file nodes. No PR body or title is
copied. A unique enrolled checkout for that GitHub repo and the merge and
parent objects must already be present; the hook never fetches. It does not
claim the rest of a multi-commit rebase, backfill missed objects, or cover
superseding fleet PRs, Inbox merges, or other merge paths.

**Before planning:** Cloud launch checks the prepared base commit and adds at
most four valid, automatically recorded PR references for files explicitly
named in the task. It sends no curated text or private source IDs, does not
change the approved-lessons trial arm, and launches without the block if the
checkout or evidence cannot be verified. Other consumers and automated
projection of the curated source kinds are follow-ups.
