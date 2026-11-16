"""Unit tests for contrib/mac/batcher.py (RQ-QUEUE-BATCH-1): grouping, prompts, outcomes, metrics, tuning.

Pure functions only. test_batching.py drives the same code through real dispatchd ticks.
"""
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import batcher as b  # noqa: E402


def task(job, area="src/core/queue", repo="phantom", tier="work", lane="devin", chars=1000):
    return {"job": job, "repo": repo, "tier": tier, "lane": lane, "area": area, "chars": chars}


def ts(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(t))


class LedgerTests(unittest.TestCase):
    def test_parse_rows_decodes_only_and_skips_bad_lines(self):
        reconciler = {"source": "metrics-outcomes-reconciler", "jobId": "RQ-B",
                      "prUrl": "https://example.invalid/9", "outcome": "MERGED"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "jobs.jsonl"
            path.write_text('{"event": "finish", "job": "RQ-A"}\nnot-json\n'
                            + json.dumps(reconciler) + "\n")
            parsed = b.parse_rows(path)
            self.assertEqual(len(parsed), 2)
            self.assertIsNone(parsed[1].get("event"))   # parse does not project
            self.assertEqual(parsed[1]["jobId"], "RQ-B")
            projected = b.project_rows(parsed)
            self.assertEqual(projected[1]["event"], "outcome")
            self.assertEqual((projected[1]["job"], projected[1]["url"]),
                             ("RQ-B", "https://example.invalid/9"))
            self.assertEqual(b.read_rows(path), projected)
            self.assertEqual(b.parse_rows(path.parent / "absent.jsonl"), [])
            self.assertEqual(b.project_rows([]), [])

    def test_project_row_leaves_dispatcher_rows_unchanged(self):
        row = {"event": "finish", "job": "RQ-X", "lane": "devin"}
        self.assertIs(b.project_row(row), row)
        for source in ("metrics-outcomes-reconciler",):
            missing_job = {"source": source, "outcome": "MERGED", "prUrl": "https://x/1"}
            missing_url = {"source": source, "outcome": "MERGED", "jobId": "RQ-Y"}
            pending = {"source": source, "jobId": "RQ-Z", "prUrl": "https://x/2", "outcome": "OPEN"}
            self.assertIs(b.project_row(missing_job), missing_job)
            self.assertIs(b.project_row(missing_url), missing_url)
            self.assertIs(b.project_row(pending), pending)

    def test_reconciled_legacy_outcomes_are_projected_without_changing_other_rows(self):
        terminal = {"source": "metrics-outcomes-reconciler", "job": "RQ-A",
                    "pr": "https://github.com/ashlrai/phantom/pull/1/", "status": "CLOSED"}
        unrelated = {"jobId": "RQ-B", "prUrl": "https://example.invalid/1", "outcome": "MERGED"}
        incomplete = {"source": "metrics-outcomes-reconciler", "outcome": "MERGED"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "jobs.jsonl"
            original = "\n".join(json.dumps(row) for row in (terminal, unrelated, incomplete))
            path.write_text(original)
            rows = b.read_rows(path)
            self.assertEqual(rows[0]["event"], "outcome")
            self.assertEqual((rows[0]["job"], rows[0]["state"], rows[0]["url"]),
                             ("RQ-A", "CLOSED", terminal["pr"].rstrip("/")))
            self.assertEqual(rows[1:], [unrelated, incomplete])
            self.assertEqual(path.read_text(), original)


class IdentityTests(unittest.TestCase):
    def test_solo_kinds_never_batch(self):
        for job in ("RQ-FIX-MAIN-phantom", "RQ-REL-1", "RQ-DESK-2", "RQ-BATCH-PHANTOM-X-1", "RQ-LAND-9",
                    "LAND-3", "RQ-FIXUP-4", "RQ-CLOSE-OLD-1", "RQ-SALVAGE-2", "bad/id"):
            self.assertFalse(b.batchable_id(job), job)
        for job in ("RQ-PHX-EMAILOUTBOX04", "RQ-QUEUE-BATCH-1", "RQ-LANDING-PAGE"):
            self.assertTrue(b.batchable_id(job), job)

    def test_area_is_the_most_named_source_directory(self):
        prompt = ("Fix src/core/queue/admission.ts and src/core/queue/store.ts; see test/pool-admission.test.ts "
                  "and docs/AGENT-OPERATIONS.md. Also `contrib/mac/dispatchd.py`.")
        self.assertEqual(b.area_of("RQ-X-1", prompt), "src/core/queue")
        self.assertEqual(b.area_of("RQ-X-1", "only test/a.test.ts and test/b.test.ts"), "test")
        self.assertEqual(b.area_of("RQ-PHX-EMAIL04", "no paths at all"), "family:PHX")
        self.assertEqual(b.area_of("12", "none"), "family:misc")
        self.assertEqual(b.area_of("RQ-X", "edit contrib/mac/dispatchd.py."), "contrib/mac")

    def test_batch_id_is_a_valid_stable_job_id(self):
        a = b.batch_id("phantom", "src/core/queue", ["RQ-B", "RQ-A"])
        self.assertEqual(a, b.batch_id("phantom", "src/core/queue", ["RQ-A", "RQ-B"]))
        self.assertRegex(a, r"^RQ-BATCH-PHANTOM-QUEUE-[0-9a-f]{8}$")
        self.assertRegex(b.batch_id("ashlr.md", "family:PHX", ["RQ-A"]), r"^RQ-BATCH-ASHLR-MD-PHX-[0-9a-f]{8}$")
        self.assertFalse(b.batchable_id(a))


class PickTests(unittest.TestCase):
    def test_same_area_first_evened_out_and_bounded(self):
        pool = [task(f"RQ-{i}") for i in range(1, 20)] + [task("RQ-OTHER", area="src/cli")]
        picked = b.pick_members(task("RQ-0"), pool, 8)
        # 20 same-area tasks over ceil(20 / 8) = 3 batches: 7, so the backlog does not end in a runt batch.
        self.assertEqual([t["job"] for t in picked], [f"RQ-{i}" for i in range(7)])

    def test_below_min_batch_launches_alone_and_tiers_mix(self):
        self.assertEqual(b.pick_members(task("RQ-0"), [], 8), [])
        self.assertEqual(b.pick_members(task("RQ-0"), [task("RQ-1", repo="locus")], 8), [])
        # RQ-BATCH-SESSIONS-2: each line gets its own subagent model, so a pair of mixed tiers bundles.
        self.assertEqual([t["job"] for t in b.pick_members(task("RQ-0"), [task("RQ-2", tier="mid")], 8)], ["RQ-0", "RQ-2"])

    def test_small_areas_merge_but_never_raid_a_batchable_area(self):
        pool = [task("RQ-A1", area="docs"), task("RQ-B1", area="src/cli"),
                task("RQ-Q1"), task("RQ-Q2"), task("RQ-Q3")]   # src/core/queue can batch by itself
        picked = [t["job"] for t in b.pick_members(task("RQ-L", area="scripts"), pool, 8)]
        self.assertEqual(picked, ["RQ-L", "RQ-A1", "RQ-B1"])

    def test_prompt_budget_skips_oversized_members(self):
        pool = [task("RQ-1", chars=b.MAX_PROMPT_CHARS), task("RQ-2"), task("RQ-3")]
        self.assertEqual([t["job"] for t in b.pick_members(task("RQ-0"), pool, 8)], ["RQ-0", "RQ-2", "RQ-3"])

    def test_size_never_drops_below_min_size(self):
        pool = [task(f"RQ-{i}") for i in range(1, 10)]
        self.assertEqual(len(b.pick_members(task("RQ-0"), pool, 1)), b.MIN_SIZE)


class PromptAndOutcomeTests(unittest.TestCase):
    def test_parse_outcomes(self):
        notes = ("- [x] RQ-A — done: fixed\n"
                 "* [ ] RQ-B - failed: flaky upstream\n"
                 "- [ ] RQ-C: skipped (already merged)\n"
                 "- [ ] RQ-D — blocked: needs owner\n"
                 "- [X] RQ-E — shipped it\n"
                 "- [ ] RQ-F — done\n"            # unchecked "done" is not evidence
                 "- [x] RQ-G — failed: retracted\n"
                 "- [ ] RQ-A — pending\n"         # a later line wins
                 "- [x] RQ-A — done: second pass\n")
        got = b.parse_outcomes(notes, ["RQ-A", "RQ-B", "RQ-C", "RQ-D", "RQ-E", "RQ-F", "RQ-G", "RQ-H"])
        self.assertEqual(got, {"RQ-A": "done", "RQ-B": "failed", "RQ-C": "skipped", "RQ-D": "deferred",
                               "RQ-E": "done", "RQ-F": "unreported", "RQ-G": "failed", "RQ-H": "unreported"})


class MetricsTests(unittest.TestCase):
    NOW = 1_800_000_000

    def rows(self):
        t = ts(self.NOW - 3600)
        return [
            {"event": "finish", "job": "S1", "lane": "devin", "wall_s": 3600, "tokens_total": 2_000_000, "ts": t},
            {"event": "finish", "job": "S2", "lane": "devin", "wall_s": 3600, "tokens_total": 2_000_000, "ts": t, "empty": True},
            {"event": "finish", "job": "S3", "lane": "devin", "wall_s": 1800, "tokens_total": 1_000_000, "ts": t},   # no PR
            {"event": "finish", "job": "B1", "lane": "devin", "wall_s": 7200, "tokens_total": 4_000_000, "ts": t, "batch_size": 10},
            {"event": "finish", "job": "OLD", "lane": "devin", "wall_s": 60, "ts": ts(self.NOW - 30 * 86400)},
            {"event": "publish", "job": "S1", "url": "u1"}, {"event": "publish", "job": "S2", "url": "u2"},
            # Per-line PRs: each done member publishes under its own job id; its own reap row is not a session.
            {"event": "finish", "job": "T0", "lane": "devin", "wall_s": 60, "ts": t, "bundle": "B1"},
        ] + [{"event": "task_outcome", "batch": "B1", "job": f"T{i}", "outcome": "done" if i < 9 else "failed"} for i in range(10)] \
          + [{"event": "publish", "job": f"T{i}", "url": f"m{i}"} for i in range(8)]   # T8 reported done, no PR yet

    def test_tasks_per_session_hour_and_per_mtok_by_mode(self):
        got = b.throughput(self.rows(), self.NOW)
        self.assertEqual(got["devin"]["single"], {"sessions": 3, "session_s": 9000, "tokens": 5_000_000, "tasks": 1,
                                                  "tasks_offered": 3, "tasks_per_session_hour": 0.4, "tasks_per_mtok": 0.2})
        self.assertEqual(got["devin"]["batch"], {"sessions": 1, "session_s": 7200, "tokens": 4_000_000, "tasks": 8,
                                                 "tasks_offered": 10, "tasks_per_session_hour": 4.0, "tasks_per_mtok": 2.0})

    def test_lane_scores_need_samples_and_choose_lane_prefers_the_best_open_lane(self):
        scores = b.lane_scores(b.throughput(self.rows(), self.NOW))
        self.assertEqual(round(scores["devin"][0], 3), round(9 / 4.5, 3))
        self.assertNotIn("claude", scores)
        scores = {"devin": (2.0, 1.0), "codex-cmp": (3.0, 0.5)}
        everything = lambda lane: True
        self.assertEqual(b.choose_lane({"devin", "codex-cmp"}, scores, everything, "devin"), "codex-cmp")
        self.assertEqual(b.choose_lane({"devin", "codex-cmp"}, scores, lambda l: l != "codex-cmp", "devin"), "devin")
        self.assertEqual(b.choose_lane({"devin"}, scores, everything, "devin"), "devin")   # only proposed lanes
        self.assertEqual(b.choose_lane({"claude"}, {}, everything, "claude"), "claude")
        self.assertIsNone(b.choose_lane({"codex-local"}, {}, everything, "codex-local"))
        self.assertIsNone(b.choose_lane({"devin"}, {}, lambda l: False, "devin"))


class TuningTests(unittest.TestCase):
    def test_grow_shrink_hold_and_clamp(self):
        t = {"schema": b.TUNING_SCHEMA, "lanes": {}}
        done = {f"T{i}": "done" for i in range(10)}
        self.assertEqual(b.tune(t, "devin", done, 3600, False, {}, 1)[:2], (8, 10))
        self.assertEqual(b.size_for(t, "devin"), 10)
        half = {f"T{i}": "done" if i < 5 else "failed" for i in range(10)}
        self.assertEqual(b.tune(t, "devin", half, 3600, False, {}, 2)[:2], (10, 7))
        mid = {f"T{i}": "done" if i < 7 else "deferred" for i in range(10)}
        self.assertEqual(b.tune(t, "devin", mid, 3600, False, {}, 3)[:2], (7, 7))
        self.assertEqual(b.tune(t, "devin", done, 3600, True, {}, 4)[2], "timeout")
        self.assertEqual(b.tune(t, "devin", done, b.WALL_BUDGET_S + 1, False, {}, 5)[:2], (4, 4))   # slow: no growth
        t["lanes"]["claude"] = {"size": 999}
        self.assertEqual(b.size_for(t, "claude"), b.DEFAULT_SIZE)
        for _ in range(20):
            b.tune(t, "devin", done, 60, False, {}, 6)
        self.assertEqual(b.size_for(t, "devin"), b.MAX_SIZE)
        self.assertLessEqual(len(t["lanes"]["devin"]["history"]), 20)

    def test_batch_slower_than_single_shrinks(self):
        t = {"schema": b.TUNING_SCHEMA, "lanes": {}}
        stats = {"devin": {"batch": {"sessions": 3, "tasks_per_session_hour": 0.5},
                           "single": {"sessions": 3, "tasks_per_session_hour": 0.9}}}
        old, new, why = b.tune(t, "devin", {"T": "done"}, 60, False, stats, 1)
        self.assertEqual((old, new, why), (8, 5, "batch slower than single"))

    def test_tuning_file_round_trip_and_report(self):
        with tempfile.TemporaryDirectory() as d:
            runs = Path(d)
            (runs / "queue").mkdir()
            (runs / "metrics").mkdir()
            self.assertEqual(b.load_tuning(str(runs / "queue/batch-tuning.json"))["lanes"], {})
            t = b.load_tuning(str(runs / "queue/batch-tuning.json"))
            b.tune(t, "devin", {"T": "done"}, 60, False, {}, 1)
            b.save_json(str(runs / "queue/batch-tuning.json"), t)
            now = time.time()
            rows = MetricsTests.rows(type("M", (), {"NOW": now})())
            (runs / "metrics/jobs.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows) + "not json\n")
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(b.main(["report", "--runs", d, "--json"]), 0)
            got = json.loads(out.getvalue())
            self.assertEqual(got["batch_sizes"]["devin"], 10)
            self.assertEqual(got["lanes"]["devin"]["batch"]["tasks_per_session_hour"], 4.0)
            out = io.StringIO()
            with redirect_stdout(out):
                b.main(["report", "--runs", d])
            self.assertIn("devin           batch", out.getvalue())


if __name__ == "__main__":
    unittest.main()
