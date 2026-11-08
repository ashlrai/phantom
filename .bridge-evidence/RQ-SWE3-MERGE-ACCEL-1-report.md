# RQ-SWE3-MERGE-ACCEL-1 — Merge acceleration analysis, `ashlrai/phantom`

**Date:** 2026-11-08 · **Base:** `master` @ `26d1e88ec` · **Sample:** last **260 merged PRs** (#3775→#4109, merged 2026-11-06T12:05Z → 2026-11-08T19:26Z, a 55.4 h window ≈ **4.7 merges/h**) · Deliverable: read-only report.

## Data sources and a hard limitation

- **PR data:** GitHub REST `GET /repos/ashlrai/phantom/pulls?state=closed` (4 pages, unauthenticated — `gh` config at `~/.config/gh` is TCC-blocked in this context). Raw pages + extracted dataset kept in `.bridge-evidence/RQ-SWE3-MERGE-ACCEL-1/` (`pulls-p*.json`, `dataset.json`, `check-runs-sample.json`).
- **Diff/size data:** local git — all 260 merge commits and head SHAs resolve in this worktree; sizes are `git show --numstat <merge_sha>` of the landed commit.
- **CI wall:** `GET /commits/{head_sha}/check-runs` on a 54-PR stratified-by-TTM sample.
- **`~/.ashlr-runs/metrics/jobs.jsonl` was unreachable.** The directory exists on this host but every read (`ls`, `read`, `phm fleet job-latency --json` → `error: unable to read jobs ledger`) is denied by the OS in this sandbox; `security`/keychain and the `ashlr`/`phantom-secrets` MCP servers are likewise unavailable. Consequences: **per-job `tier`, effective `model`, and the queued→launch→checkout→finish phase splits are not measurable here.** TTM below is PR `created_at → merged_at`; the push→open half is ~0.1 min (measured), so the PR-open boundary sits immediately after job finish — the front half of job latency (queue wait, work time) lives only in the blocked ledger. `pool` (lane) is recovered from the `pool: X` field in PR bodies; tier/model joins are described in "Reproduce with the ledger" for a run on an unsandboxed context.
- Pool→provider map (from `contrib/mac/dispatchd.py`): `codex-cmp`/`codex-personal`→Codex, `claude`/`claude-api`→Anthropic, `devin`→Devin, `codex-local`→local model (loopback), `operator`→manual.

## Headline

**p50 time-to-merge is 2.6 minutes; 78 % (202/260) merge inside 5 min.** The merge pipeline is not slow — the *schedule* is. All latency lives in a thin tail: **25 PRs waited ≥1 h**, untouched from open to merge (`updated_at == merged_at`), i.e. pure queue/window wait, not rework. Median CI wall on PR heads is ~3–4 min and merges do not wait for advisory checks (CodeRabbit is non-success on 38/54 sampled merged PRs).

Merge cadence is bursty, not hourly-smooth: 16 inter-merge gaps ≥1 h (max **3.0 h**); bursts at Nov 7 07–09Z (45 merges), Nov 7 19–23Z (63 merges), Nov 8 02–03Z (13). In the same window **140 PRs were closed unmerged** (median age-at-close 5.5 days; 130/140 closed Nov 7 19Z→Nov 8 04Z) — the stale-PR cleanup wave.

## Time-to-merge by lane (pool)

| Pool | Merges | Share | p50 | Mean | p90 | Max | ≥60 m stalls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| codex-personal | 131 | 50 % | 2.4 m | 238 m | 20.6 m | 15 701 m | 8 |
| devin | 43 | 17 % | 2.6 m | 64 m | 4.8 m | 915 m | 3 |
| claude-api | 18 | 7 % | 2.8 m | 5.5 m | 20.6 m | 25.0 m | **0** |
| codex-cmp | 17 | 7 % | 5.5 m | 160 m | 870 m | 872 m | 3 |
| human | 12 | 5 % | 5.3 m | 2 501 m | 9 862 m | 15 844 m | 3 |
| codex-local | 11 | 4 % | 2.6 m | 91 m | 25.7 m | 953 m | 1 |
| release-please | 11 | 4 % | 9.8 m | 18.9 m | 35.0 m | 74.0 m | 1 |
| bridge (pre-`pool:` bodies) | 11 | 4 % | 9.2 m | 1 322 m | 4 035 m | 4 129 m | 5 |
| operator | 5 | 2 % | 2.9 m | 2.8 m | 3.6 m | 3.6 m | **0** |
| claude | 1 | <1 % | 6 598 m | — | — | — | 1 |

`claude-api` and `operator` are the cleanest lanes (zero stalls). `devin` is healthy: p50 2.6 m, p90 4.8 m. `codex-personal` carries half the fleet and its p50 is excellent, but it owns a third of the stalls because it produces most of the drain/recut volume. The pre-`pool:`-format bridge PRs are Nov-4/5 vintage — the oldest live work — and stall hardest.

## Time-to-merge by job type

| Job type | n | p50 | Mean | p90 | Max | ≥60 m stalls |
| --- | --- | --- | --- | --- | --- | --- |
| analysis/meta (RQ-SWE*, audits) | 54 | 2.5 m | 2.5 m | 3.0 m | 3.5 m | **0** |
| ci-fix (RQ-CIFIX*/RQ-CI-*/FIXUP-CI) | 21 | 2.4 m | 3.0 m | 5.5 m | 9.2 m | **0** |
| merge-infra (RQ-MERGE*/REAP*/PARKWAKE) | 20 | 2.4 m | 3.7 m | 9.8 m | 20.6 m | **0** |
| upkeep (RQ-UPKEEP-*) | 3 | 2.3 m | 2.7 m | 3.6 m | 3.6 m | **0** |
| release-eng (RQ-RELEASE-*) | 4 | 4.8 m | 4.5 m | 4.8 m | 4.8 m | **0** |
| queue-drain/rebase (DRAIN*/REBASE*/RECUT*) | 63 | 2.5 m | 261 m | 3.5 m | 9 670 m | 2 |
| rq-other (feature/fix RQ-*) | 49 | 3.0 m | 465 m | 872 m | 15 701 m | 5 |
| agentnet / econ | 2 | 3.6–4.0 m | — | — | — | 0 |
| **phx-fleet (RQ-PHX-*)** | 17 | **856 m** | 941 m | 4 035 m | 4 129 m | **10** |
| **oss (RQ-OSS-*)** | 4 | **868 m** | 867 m | 870 m | 870 m | **4** |
| release (release-please train) | 11 | 9.8 m | 18.9 m | 35.0 m | 74.0 m | 1 |
| human-pr | 12 | 5.3 m | 2 501 m | 9 862 m | 15 844 m | 3 |

**Fastest:** analysis/meta reports, CI fixes, merge-infra, upkeep — all ≤4 min p50 with zero ≥1 h stalls. These are small, generated, single-commit diffs that pass the fast gate instantly.

**Stallers:**
- **`RQ-PHX-*` reconcile/epic jobs — the single worst cohort**: p50 14.3 h, 10/17 waited ≥1 h, 9/17 needed multi-push rework. They open during morning bursts then sit until the evening merge window.
- **`RQ-OSS-*`**: all four waited ~14.5 h (the same Nov-6→7 overnight wave).
- **Old-vintage bridge PRs** (Nov 4–5, pre-`pool:` body format): #3275 (67 h), #3276 (66 h), #3280 (69 h), #3648 (38 h) — all merged only when the Nov-7 drain wave reached them.
- **Human PRs** wait days (#1152: 11 days; #1550: 6.8 d; #3260: 2.9 d) — human review, outside queue scope.
- Release-train PRs run a stable ~10 min — the train's own cadence, not a stall.

## Stall anatomy

Every ≥1 h stall was **idle the entire window** — no pushes, reviews, or edits between `created_at` and `merged_at`. Two distinct waves:

1. **Nov-6 03:46–05:24Z open wave** (#3709–#3734: PHX-reconcile, OSS, guardian jobs) → all merged Nov 7 ~19–20Z after **14–16 h** idle.
2. **Nov-4/5 leftovers** (#3275/#3276/#3280/#3648, plus ancient #1164/#1516/#2826) → merged only in the Nov-7 cleanup, **38 h–11 days** idle.

PR size does not explain stalls (≤3-file PRs: p90 861 m). Multi-push rework branches (n=53) concentrate in phx-fleet (9) — those jobs rebase-churn while waiting.

## Waste signal: empty merges

**13 merged commits (5 %) are literal no-ops** — single-parent squash commits with zero changed files, i.e. the job's intent was already on master. Nearly all are drain/recut/cifix wave jobs (`RQ-DRAIN*`, `RQ-REBASE*`, `RQ-CIFIX*`); 9 merged in 1–3 min of fresh queue time, but #1164/#1516/#2826/#3648 each burned days of queue residency before merging empty.

## CI gate observations (54-PR sample)

- 16–18 check runs per PR head; wall time 0.7–10.5 min typical (two outliers 22–39 min on old heads).
- `CodeRabbit` non-success on 38/54 merged PRs → advisory, not a gate; merges proceed around it.
- Merges complete ~2.5 min after open even though full check walls run longer → only a **fast required-check subset** gates merge, consistent with the Oct-28 "fast gate on PRs, full suite scheduled" policy.

## Recommendations for queue prioritization

1. **Front-run the fast classes.** analysis/meta, ci-fix, merge-infra, upkeep, release-eng clear the gate in ≤5 min p50 — schedule them as fill between merge bursts; they cost almost nothing per merge slot.
2. **Batch or split `RQ-PHX-*` epics.** They stall ~14 h median and rework 53 % of the time. Either dispatch them into the evening drain window explicitly, or split epic scopes into ≤10-file PRs — their stall is a schedule miss, not a gate failure.
3. **Add a pre-dispatch "intent already on master" check** to queuegen/restock for DRAIN/RECUT/CIFIX waves — 5 % of merges are empty no-ops; checking `git merge-tree`/path-presence before launch eliminates the whole class.
4. **Rebase-or-close for pre-`pool:` vintage PRs.** The Nov-4/5 bridge PRs are the worst stalls; the Nov-7 close wave already proved the mechanism — extend it to merge-or-close at ~48 h rather than waiting for the cleanup sweep.
5. **Watch the merge window, not the gate.** 16 gaps ≥1 h (max 3 h) with no idle-time pattern beyond scheduling → a merge-window watchdog/continuous closer compresses p90 far more than any CI speedup. The 19–23Z collision of the close wave and merge burst also suggests sequencing closes *after* merges so they don't compete for the same window.
6. **Keep `claude-api`/`operator`/`devin` mixes steady** — zero-to-few stalls at current volumes; `codex-personal` carries half the fleet's merges and is where drain-wave volume should be trimmed (see rec. 3).
7. **Join tier/model on the dispatch host.** Re-run this analysis where `~/.ashlr-runs` is readable to add `tier=` from `queue/ready.tsv` and `model` from `models.json`/`phm fleet lane-models`; the dataset here (`dataset.json`, keyed by PR/job-id/head-sha) is the join key.

## Reproduce with the ledger

```sh
phm fleet job-latency --json                                    # phase splits: queued→launch→…→merged
phm fleet eval-report --prs prs.json --json                     # lane×tier rollups (needs runs dir)
gh pr list --state merged --limit 200 --json url,number,title,mergedAt,mergeCommit,files,statusCheckRollup,commits,body
```

`dataset.json` here is equivalent to that `gh pr list` output plus per-PR pool/jtype/size columns.

## Files

- `RQ-SWE3-MERGE-ACCEL-1/pulls-p{1..4}.json` — raw REST pulls pages (400 closed PRs → 260 merged + 140 closed-unmerged)
- `RQ-SWE3-MERGE-ACCEL-1/dataset.json` — enriched per-PR rows (ttm_min, pool, jtype, files, adds/dels, branch_commits, head_commit)
- `RQ-SWE3-MERGE-ACCEL-1/check-runs-sample.json` — 54-PR check-run detail

## Limitations

- Tier and per-lane model are unrecoverable without `~/.ashlr-runs` reads (TCC-blocked here); lane≈pool and provider≈model stand-ins are used.
- TTM = PR open→merge; queued→finish phases are not in PR data and would need `jobs.jsonl`.
- Closed-unmerged set is truncated to the 140 most recently updated (page-4 boundary) — enough to characterize the wave, not its full extent.
- Check-run coverage is a 54-PR stratified sample, not the full 260.
