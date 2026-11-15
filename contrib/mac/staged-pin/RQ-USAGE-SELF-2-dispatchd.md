# Pin package for Security: dispatchd.py budget lanes (RQ-USAGE-SELF-2)

Not applied. `bin/dispatchd.py` is pinned; this change must go through Security.

## Why

`usage-self` writes `weekly_used_pct`, `credits_remaining`, `reset_at`, `source`, `estimated`,
`as_of` for claude, codex-personal, devin, zai, gemini and omlx into `queue/budget-overrides.json`.
dispatchd builds `status.json.budget` only for `LANES`
(`codex-cmp, codex-personal, claude, devin, claude-api, codex-local`), so the zai, gemini and omlx
entries never reach status.json or the resource bar. Without this change claude, codex-personal and
devin already work (their extra keys pass through `dict(ov.get(l, {}))`).

## Change (one loop header in the budget block, near `for l in LANES:` after `ov = jload(...)`)

```diff
-for l in LANES:
+for l in list(LANES) + [k for k in ("zai", "gemini", "omlx") if k in ov and k not in LANES]:
```

`tokens_per_hour_6h` for those extra lanes is computed from jobs.jsonl `lane == l` exactly as today.
No new reads, no new writes, no new subprocess. Lane slots, floors, ceilings and hard caps are untouched.

## Verify

`python3 -m pytest contrib/mac/tests -q` plus one tick with a budget-overrides.json containing a `zai`
block: `status.json.budget.zai.weekly_used_pct` must be present.
