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

## Browse in the desktop app

In **Repo Wiki**, select an enrolled repository and open **System map**. No
generated wiki is required. Select a subsystem, then use **Explore subsystem**
to see its files. Explore a file to see its declarations, then inspect a
declaration for its source line. Arrow keys select nodes, Enter opens the
selection, and Escape or the breadcrumb takes you back. Only the selected
node's connections are drawn. File and declaration views focus on containment;
import evidence and related files remain available in the details panel.

The map shows its pinned commit, coverage counts, and any view truncation.
If HEAD changes during navigation, the map returns to the overview rather
than combining snapshots. Source links open the exact commit and line on
the repo's GitHub origin. Without a GitHub origin, the map still shows the
anchor and does not open a potentially different working-tree file.

Memory links and planning/merge integration are separate slices.
