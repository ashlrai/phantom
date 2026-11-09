# PR impact map

This read-only view reuses `.github/scripts/ci-impact-shadow.mjs` and its immutable
Git input graph. It maps changed files to current test modules through direct and
transitive imports in each source version. Deleted files retain their old-tree
relationships. Edges from different source versions are not combined into paths
that never existed. Cycles are handled without repeated traversal.

```sh
node .github/scripts/ci-impact-map.mjs ROOT BASE_SHA HEAD_SHA mac-general-1
node .github/scripts/ci-impact-map.mjs ROOT BASE_SHA HEAD_SHA mac-general-1 --html
```

`ROOT` is a clean checkout of the exact `HEAD_SHA`; both revisions must already be
available locally. Redirect stdout to a JSON or HTML file outside that checkout.
Use `web` for frontend test candidates. The other supported role names come from
the existing impact policy. The HTML is self-contained, searchable, and expands
each changed file's known test connections. No assets or scripts are fetched.

The map distinguishes observed role modules from source candidates. Source-only
analysis is not Vitest collection or shard membership. It preserves the analyzer's
incomplete-coverage status and changes no test selection or release policy.
Filesystem reads, generated inputs, workflow invocations, environment, computed
imports and package behavior can introduce dependencies outside known import edges.
Tests without a known path are labeled coverage-unproven, not safe to omit.

The JSON retains available reporter timing metadata without treating overlapping
test spans as CPU time or claiming a speedup. Use the map for focused review and
to identify the next dependency edges to verify. Whole-tree equality, when shown,
is a source observation here; a separate trusted CI proof decides whether a history
merge can avoid duplicate checks. No historical results are inherited by this view.
