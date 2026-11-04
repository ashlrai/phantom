# `phm disk` fixture tree

Static fixture for `test/disk.test.ts`. `wt/` stands in for
`~/Projects/ashlrai/wt`, `runs/` for `~/.ashlr-runs` and `tmp/` for
`~/.ashlr/tmp`. The suite injects `now = 2026-10-02T12:00:00Z`, so:

- `RQ-MERGED-A` merged 36 h ago — safe to clean up.
- `RQ-KEPT-C` merged 36 h ago — kept by an injected pin.
- `RQ-FRESH-F` merged 29 min ago — too new to clean up.
- `RQ-EMPTY-E` finished empty 36 h ago — safe to clean up.
- `RQ-OPEN-B` is still open — kept.
- `guardian-x` is a lane guardian — never listed.
- `tmp/vwt-aa11bb` and `tmp/mwt-22cc33` are crash-leftover temp worktrees;
  `tmp/scratch-notes` does not match the temp-name pattern and is ignored.
- `runs/quarantine/RQ-Q-1` is publish-leftover quarantine — kept on purpose.
