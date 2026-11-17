# Proposal: capability fit check in the live dispatcher

Status: proposed, for Security review. Job RQ-LANECAPSN16LQ8.
Nothing in this file is installed. The live dispatcher is sha-pinned under the
runs directory and changes only through a Security pin.

## Problem

On 2026-11-16, 22:38-22:48 ET, four claude-lane jobs (RECUTCOREFLEETC499,
RECUTFLEETCLIC499, RECUTTESTONLYC499, REDTESTFIXC499) each ended EMPTY in
24-27 seconds. The claude worker sandbox cannot read the gh config
("operation not permitted"), so every gh call failed before step 1. Each run
spent a launch slot, and launch slots are the scarcest resource.

## What already shipped in Phantom (no pin needed)

- `phm route fit --input - [--worktree <directory>] --json`: the typed check
  and the gh context pack writer. See [routing](../ROUTING.md#lane-capability-fit).
- `phm queue --json` field `routeSkips`: a read-only forecast over
  `queue/ready.tsv`, so the mismatch is visible today.

Neither changes a launch. The dispatcher still sends gh jobs to claude until
the change below is pinned.

## Proposed change to `dispatchd.py`

At the launch-time re-check (the block that already skips RETIRED jobs), for
each ready row about to launch on lane `L`:

1. Build the request from data the dispatcher already holds: job id, lane,
   the prompt file under `queue/prompts`, and `candidates` = lanes of the same
   tier that are not held and have a free slot.
2. Run the fixed command with a 2-second timeout, prompt on stdin, no shell:
   `~/.local/bin/phm route fit --input - --json`.
3. Accept the answer only when `schema` is `route.fit.v1`, `decision` is one of
   the three known values and `code` is null or matches
   `route_skip: lane lacks (gh|network|browser|local_fs_outside_worktree)`.
4. On `route_skip` with a `next_lane`: do not launch. Move the row to
   `next_lane` through the existing `route_decision` path (minimum residency and
   move caps still apply) and record
   `ev("ROUTE_SKIP <job> <lane> lane lacks <capability> -> <next_lane>")` plus a
   `route_skip` metric row with the typed code.
5. On `route_skip` with no `next_lane`: leave the row ready and record the
   same event with `-> wait`. Do not launch it on `L`.
6. On timeout, missing CLI or invalid output: launch as today and record
   `route_fit_unavailable`. The check can only prevent a wasted launch; it can
   never hold the queue.

```python
def route_fit(job, lane, prompt_path, candidates):
    request = {"job": job, "lane": lane, "prompt": rd(prompt_path)[:1000000], "candidates": candidates}
    with tempfile.TemporaryFile(mode="w+") as source:
        json.dump(request, source); source.seek(0)
        result = _run([H + "/.local/bin/phm", "route", "fit", "--input", "-", "--json"], 2.0, stdin=source)
    fit = json.loads(result.stdout) if result.returncode == 0 and len(result.stdout) <= 65536 else None
    ok = (isinstance(fit, dict) and fit.get("schema") == "route.fit.v1"
          and fit.get("decision") in ("route", "route_with_pack", "route_skip")
          and (fit.get("code") is None or re.fullmatch(
              r"route_skip: lane lacks (gh|network|browser|local_fs_outside_worktree)", fit["code"])))
    return fit if ok else None
```

## Proposed gh context pack step

When the answer is `route_skip`, `pack_would_fix` is true and the operator has
not set `queue/GH_PACK_OFF`:

1. Outside the sandbox, with the dispatcher's existing gh login, run one
   read-only call: `gh pr list --repo ashlrai/<repo> --state open --limit 200
   --json number,title,headRefName,mergeable,isDraft,updatedAt,url`. For a
   red-test job, also read the newest failed run and its `--log-failed` text.
2. After the worktree exists, call `phm route fit` again with `gh_context` and
   `--worktree <worktree>`. Phantom scrubs and bounds the data and writes
   `.ashlr/gh-context.json`.
3. Append the returned `pack.prompt_note` to the job's prompt and launch on
   the original lane.

No token, gh config path or environment value is passed to Phantom or written
to the worktree. The pack holds public PR metadata and a scrubbed log tail.

## Points for Security

- The worktree is created by `launch.sh`, which is not in this repository.
  Step 2 has to run there, after the worktree exists and before the agent
  starts. That placement is unverified.
- `.ashlr/` is git-ignored in phantom. Other repositories need the same ignore
  line, or `publish.sh` must exclude `.ashlr/gh-context.json`.
- PR titles and log text are untrusted input to the worker. The prompt note
  says the file is data, not instructions; that is a mitigation, not a control.
- Prompt inference is pattern matching. A missed need wastes one launch, as
  today. A false need moves a job to another lane.

## Rollback

Create `queue/ROUTE_FIT_OFF` (checked before step 1) or re-pin the previous
script. Phantom's side is read-only and needs no rollback.
