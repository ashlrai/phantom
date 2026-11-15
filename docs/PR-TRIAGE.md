# PR triage

```sh
phm prs triage --repo ashlrai/phantom --limit 100 --json
```

The read-only `prs.triage.v1` report contains `repo`, `generatedAt`, `complete` (false when the limit is reached), verdict `counts`, and `prs`. Each PR has `number`, `headBranch`, GitHub `mergeable`, `checks` (success, failure, pending, or unknown), `ageSeconds`, and `verdict`. GitHub metadata is a snapshot; fetched heads must match it. No GitHub writes are made.

`superseded` means the entire nonempty net binary patch reverse-applies to the fetched base index. `rebase-clean` and `rebase-manual` describe a trial merge-tree for a GitHub-conflicting PR. Otherwise failing checks and green checks give `failing-checks` and `green`. Missing evidence, pending checks, moved heads, and inspection errors yield `unknown`. A clean trial merge is advisory and does not prove a rebase or CI will succeed. Reverse application is conservative: context changes can hide already-landed hunks.
