import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class LaunchState(unittest.TestCase):
    def test_duplicate_events_keep_one_attempt_until_terminal(self):
        from launch_precheck import update_launch_state
        for terminal in ('finish', 'launch_terminal'):
            with self.subTest(terminal=terminal):
                active = set()
                for event in ('claim', 'launch', 'launch'):
                    update_launch_state(active, dict(event=event, job='RQ-ONE', launch_dedupe=True))
                self.assertEqual(active, {'RQ-ONE'})
                update_launch_state(active, dict(event=terminal, job='RQ-OTHER'))
                self.assertEqual(active, {'RQ-ONE'})
                update_launch_state(active, dict(event=terminal, job='RQ-ONE'))
                self.assertEqual(active, set())
                update_launch_state(active, dict(event='launch', job='RQ-ONE'))
                self.assertEqual(active, {'RQ-ONE'})

    def test_old_pr_resolution_and_legacy_claim_do_not_change_active_attempt(self):
        from launch_precheck import update_launch_state
        active = set()
        for row in (None, {}, dict(event='launch', job=[]), dict(event='claim', job='RQ-OLD')):
            update_launch_state(active, row)
        self.assertEqual(active, set())
        update_launch_state(active, dict(event='launch', job='RQ-ONE'))
        update_launch_state(active, dict(event='outcome', job='RQ-ONE', state='MERGED', url='https://github.com/o/r/pull/1'))
        self.assertEqual(active, {'RQ-ONE'})


class LandFreshness(unittest.TestCase):
    job = "RQ-PHX-CONSOLELAND791"
    prompt = job + " (repo=phantom, pr=41): Recut source PRs #41 and #42."

    def test_all_sources_must_be_terminal_in_both_live_and_local_evidence(self):
        from launch_precheck import land_freshness, terminal_target
        for states in (("MERGED", "MERGED"), ("CLOSED", "CLOSED"), ("MERGED", "CLOSED"),
                       ("MERGED", "OPEN"), ("OPEN", "CLOSED"), ("MERGED", None)):
            with self.subTest(states=states):
                def runner(cmd, timeout, **kwargs):
                    self.assertEqual(cmd[:6], ["locus", "exec", "--", "gh", "pr", "view"])
                    self.assertEqual((timeout, cmd[-1]), (3, "number,state"))
                    n = int(cmd[6])
                    return subprocess.CompletedProcess(cmd, 0, json.dumps(dict(number=n, state=states[n - 41])), "")
                expected = "source_prs_terminal" if all(s in ("MERGED", "CLOSED") for s in states) else None
                self.assertEqual(land_freshness(self.job, "phantom", self.prompt, "/fixture", runner), expected)
                local = {f"https://github.com/ashlrai/phantom/pull/{n}": s for n, s in zip((41, 42), states)}
                self.assertEqual(terminal_target(self.job, "phantom", self.prompt, local), expected)

    def test_unavailable_malformed_mismatched_or_oversized_reads_never_skip(self):
        from launch_precheck import land_freshness
        for code, output in ((1, "private output"), (0, "{"), (0, "[]"), (0, "x" * 65537),
                             (0, '{"number":42,"state":"MERGED"}')):
            self.assertIsNone(land_freshness(self.job, "phantom", self.prompt, "/fixture",
                lambda *a, **k: subprocess.CompletedProcess([], code, output, "")))
        def timeout(*args, **kwargs): raise subprocess.TimeoutExpired([], 3)
        self.assertIsNone(land_freshness(self.job, "phantom", self.prompt, "/fixture", timeout))

    def test_only_task_sources_count_and_incomplete_sets_stay_unknown(self):
        from launch_precheck import land_sources
        self.assertEqual(land_sources(self.job, "phantom", "Context #99\n" + self.prompt + "\nRules #88"), (41, 42))
        self.assertEqual(land_sources(self.job, "phantom", self.prompt + " https://github.com/ashlrai/phantom/pull/42 phantom#41"), (41, 42))
        self.assertEqual(land_sources(self.job, "phantom", self.prompt.replace("#41 and #42", "#41/#42")), (41, 42))
        for job in ("LAND-RECUT-phantom-41", "RQ-LAND-PR41"):
            self.assertEqual(land_sources(job, "phantom", f"{job} (repo=phantom): Recut the source."), (41,))
        for prompt in (self.prompt + " locus#43", self.prompt + " https://github.com/other/phantom/pull/43",
                       self.prompt + " other/phantom#43", self.prompt + "\n" + self.prompt,
                       self.prompt + " #43 #44 #45 #46 #47 #48 #49", "Context #41"):
            self.assertEqual(land_sources(self.job, "phantom", prompt), ())
        self.assertEqual(land_sources("RQ-LANDSKIPQ8", "phantom", "RQ-LANDSKIPQ8 (repo=phantom): test #41"), ())

    def test_legacy_single_source_receipt_cannot_retire_mixed_work(self):
        from launch_precheck import precheck
        for code, reason, expected in ((10, "pr_41_MERGED", None), (11, "pr_41_green_clean", None),
                                       (12, "id_open_pr_99", (12, "id_open_pr_99"))):
            def runner(cmd, *args, **kwargs):
                if cmd[0] == "/bin/bash":
                    return subprocess.CompletedProcess(cmd, code, f"SKIP {self.job} code={code} reason={reason}\n", "")
                n = int(cmd[6])
                return subprocess.CompletedProcess(cmd, 0, json.dumps(dict(number=n, state="MERGED" if n == 41 else "OPEN")), "")
            self.assertEqual(precheck(self.job, "phantom", self.prompt, "/fixture", "/fixture/runs", runner), expected)


class RepairFreshness(unittest.TestCase):
    def test_only_current_complete_matching_evidence_retires_a_repair(self):
        from launch_precheck import repair_freshness
        base = dict(number=42, state="OPEN", headRefOid="a" * 40, mergeable="MERGEABLE",
                    statusCheckRollup=[dict(__typename="CheckRun", name="Merge Gate", status="COMPLETED", conclusion="SUCCESS"),
                                       dict(__typename="StatusContext", state="SUCCESS")])
        for kind, patch, expected in (
            ("FIXUP", {}, "target_pr_checks_resolved"),
            ("REBASE", {}, "target_pr_conflicts_resolved"),
            ("RECUT", {}, "target_pr_conflicts_resolved"),
            ("FIXUP", dict(state="CLOSED"), "target_pr_closed"),
            ("FIXUP", dict(state="MERGED"), "target_pr_merged"),
            ("FIXUP", dict(number=43), None),
            ("FIXUP", dict(headRefOid="b" * 40), None),
            ("FIXUP", dict(statusCheckRollup=[]), None),
            ("FIXUP", dict(statusCheckRollup=None), None),
            ("FIXUP", dict(statusCheckRollup=[{}]), None),
            ("FIXUP", dict(statusCheckRollup=[dict(__typename="StatusContext", context="other", state="SUCCESS")]), None),
            ("FIXUP", dict(statusCheckRollup=[dict(__typename="CheckRun", status="IN_PROGRESS", conclusion="SUCCESS")]), None),
            ("FIXUP", dict(statusCheckRollup=[dict(__typename="StatusContext", state="PENDING")]), None),
            ("FIXUP", dict(statusCheckRollup=[dict(__typename="CheckRun", status="COMPLETED", conclusion="FAILURE")]), None),
            ("REBASE", dict(mergeable="UNKNOWN"), None),
            ("RECUT", dict(mergeable="CONFLICTING"), None),
        ):
            with self.subTest(kind=kind, patch=patch):
                def runner(cmd, timeout, **kwargs):
                    self.assertEqual(cmd[:4], ["locus", "exec", "--", "gh"])
                    self.assertEqual(timeout, 3)
                    self.assertIn("ashlrai/phantom", cmd)
                    return subprocess.CompletedProcess(cmd, 0, json.dumps(dict(base, **patch)), "")
                job = f"RQ-{kind}-phantom-42-aaaaaaa"
                self.assertEqual(repair_freshness(job, "phantom", f'{job} (P1): check="Merge Gate"', "/fixture", runner), expected)

    def test_unknown_output_and_unrelated_targets_never_retire_work(self):
        from launch_precheck import repair_freshness, terminal_target
        for code, output in [(1, "private output"), (0, "{"), (0, "[]"), (0, "x" * 65537)]:
            self.assertIsNone(repair_freshness("RQ-FIXUP-phantom-42-aaaaaaa", "phantom", "", "/fixture",
                lambda *a, **k: subprocess.CompletedProcess([], code, output, "")))
        def unavailable(*args, **kwargs): raise subprocess.TimeoutExpired([], 3)
        self.assertIsNone(repair_freshness("RQ-REBASE-phantom-42-aaaaaaa", "phantom", "", "/fixture", unavailable))
        for job, repo in [("RQ-FIXUP-phantom-42-aaaaaaa-more", "phantom"),
                          ("RQ-FIXUP-locus-42-aaaaaaa", "phantom"), ("RQ-FEATURE-42", "phantom")]:
            self.assertIsNone(repair_freshness(job, repo, "", "/fixture", lambda *a, **k: self.fail("unexpected read")))
        states = {"https://github.com/ashlrai/phantom/pull/42": "CLOSED"}
        self.assertEqual(terminal_target("RQ-REBASE-phantom-42-aaaaaaa", "phantom", "", states), "target_pr_closed")
        self.assertIsNone(terminal_target("RQ-REBASE-phantom-42-aaaaaaa", "phantom",
                                        "RQ-REBASE-phantom-42-aaaaaaa (pr=43): repair", states))


class RestockPrecheck(unittest.TestCase):
    def test_only_completed_work_is_retired(self):
        script = Path(__file__).with_name('restock.py').resolve()
        for code in (0, 10, 11, 12, 13, 2):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as home:
                root = Path(home)
                queue = root / '.ashlr-runs/queue'
                (queue / 'prompts').mkdir(parents=True)
                (queue / 'admission.json').write_text('{"cap": 10}')
                (queue / 'ready.tsv').write_text('')
                (root / 'Projects/ashlrai/phantom').mkdir(parents=True)
                binary = root / '.ashlr-runs/bin'
                binary.mkdir()
                (binary / 'precheck.sh').write_text(f'echo SKIP RQ-TEST code={code} reason=id_merged_pr_7\nexit {code}\n')
                source = '- READY RQ-TEST (P0, pool=codex-cmp, repo=phantom): test task\n'
                (queue / 'router-queue.md').write_text(source)
                env = dict(os.environ, HOME=home, PYTHONDONTWRITEBYTECODE='1')
                def run(*args):
                    return json.loads(subprocess.check_output(['python3', str(script), '--json', *args], env=env, text=True))
                dry = run('--dry-run')
                self.assertEqual((queue / 'router-queue.md').read_text(), source)
                self.assertEqual((queue / 'ready.tsv').read_text(), '')
                result = run()
                done = code == 10
                blocked = code in (11, 12, 13)
                self.assertEqual(result['queued'], 0 if done or blocked else 1)
                self.assertEqual(dry['done_noop'], ['RQ-TEST'] if done else [])
                ready = (queue / 'ready.tsv').read_text() if (queue / 'ready.tsv').exists() else ''
                self.assertEqual('RQ-TEST' in ready, not (done or blocked))
                self.assertEqual('DONE-NOOP' in (queue / 'router-queue.md').read_text(), done)
                self.assertEqual((queue / 'prompts/RQ-TEST.md').exists(), not (done or blocked))
                claimed = (queue / 'claimed.tsv').read_text() if (queue / 'claimed.tsv').exists() else ''
                self.assertEqual('RQ-TEST' in claimed, not (done or blocked))
                if blocked:
                    self.assertEqual((queue / 'router-queue.md').read_text(), source)
                    state = json.loads((queue / 'restock-precheck-parked.json').read_text())['RQ-TEST']
                    self.assertEqual(state['code'], code)
                    if code == 13:
                        self.assertEqual(state['reason'], 'invalid_or_unknown_receipt')
                    self.assertGreater(state['retry_at'], 0)


    def test_completion_requires_exact_receipt(self):
        from launch_precheck import precheck
        for output in ('reason=already-done', 'SKIP RQ-OTHER code=10 reason=id_merged_pr_7',
                       'SKIP RQ-TEST code=10 reason=files_exist',
                       'SKIP RQ-TEST code=10 reason=id_merged_pr_7\nextra'):
            with self.subTest(output=output):
                def runner(*args, **kwargs):
                    return subprocess.CompletedProcess([], 10, output, '')
                self.assertEqual(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                          '/fixture', '/fixture/runs', runner),
                                 (13, 'unproven_completion'))

    def test_code_13_reasons_are_specific_and_untrusted_output_is_not_recorded(self):
        from launch_precheck import precheck
        for output, expected in (
            ('SKIP RQ-TEST code=13 reason=files_and_tests_exist\n', 'files_and_tests_exist'),
            ('SKIP RQ-TEST code=13 reason=symbols_defined\n', 'symbols_defined'),
            ('SKIP RQ-OTHER code=13 reason=symbols_defined\n', 'invalid_or_unknown_receipt'),
            ('SKIP RQ-TEST code=13 reason=private_value\n', 'invalid_or_unknown_receipt'),
            ('', 'invalid_or_unknown_receipt'),
        ):
            with self.subTest(expected=expected):
                def runner(*args, **kwargs):
                    return subprocess.CompletedProcess([], 13, output, '')
                self.assertEqual(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                          '/fixture', '/fixture/runs', runner), (13, expected))


class EmptyStreakPrecheck(unittest.TestCase):
    """A job id whose last finishes all came back empty is retired, not relaunched."""

    def runs(self, root, rows):
        runs = Path(root) / '.ashlr-runs'
        (runs / 'metrics').mkdir(parents=True)
        text = ''.join(json.dumps(row) + '\n' for row in rows)
        (runs / 'metrics' / 'jobs.jsonl').write_text(text)
        return str(runs)

    def test_two_trailing_empty_finishes_suppress_without_a_subprocess(self):
        from launch_precheck import EMPTY_CODE, precheck
        with tempfile.TemporaryDirectory() as home:
            runs = self.runs(home, [
                {'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
                {'event': 'finish', 'job': 'RQ-OTHER', 'empty': True},
                {'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
            ])
            calls = []
            def runner(*args, **kwargs):
                calls.append(args)
                return subprocess.CompletedProcess([], 0, 'GO RQ-TEST\n', '')
            self.assertEqual(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                      '/fixture', runs, runner), (EMPTY_CODE, 'empty_streak_2x'))
            self.assertEqual(calls, [])

    def test_single_empty_and_newer_evidence_fail_open(self):
        from launch_precheck import precheck
        cases = (
            # One empty finish is a flake, not proof.
            [{'event': 'finish', 'job': 'RQ-TEST', 'empty': True}],
            # A productive finish breaks the streak.
            [{'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
             {'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
             {'event': 'finish', 'job': 'RQ-TEST', 'empty': False}],
            # An unmeasured finish is not empty evidence.
            [{'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
             {'event': 'finish', 'job': 'RQ-TEST'}],
            # A merge after the empties is newer terminal evidence.
            [{'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
             {'event': 'finish', 'job': 'RQ-TEST', 'empty': True},
             {'event': 'outcome', 'job': 'RQ-TEST', 'state': 'MERGED'}],
        )
        for rows in cases:
            with self.subTest(rows=rows), tempfile.TemporaryDirectory() as home:
                runs = self.runs(home, rows)
                def runner(*args, **kwargs):
                    return subprocess.CompletedProcess([], 0, 'GO RQ-TEST\n', '')
                self.assertIsNone(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                           '/fixture', runs, runner))

    def test_terminal_empty_outcome_rows_count_as_empty_evidence(self):
        from launch_precheck import EMPTY_CODE, precheck
        with tempfile.TemporaryDirectory() as home:
            runs = self.runs(home, [
                {'event': 'outcome', 'job': 'RQ-TEST', 'outcome': 'DONE-NOOP'},
                {'event': 'outcome', 'job': 'RQ-TEST', 'state': 'EMPTY'},
            ])
            self.assertEqual(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                      '/fixture', runs, lambda *a, **k: None), (EMPTY_CODE, 'empty_streak_2x'))

    def test_missing_malformed_and_empty_ledgers_never_suppress(self):
        from launch_precheck import precheck
        with tempfile.TemporaryDirectory() as home:
            runs = str(Path(home) / '.ashlr-runs')
            def runner(*args, **kwargs):
                return subprocess.CompletedProcess([], 0, 'GO RQ-TEST\n', '')
            self.assertIsNone(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                       '/fixture', runs, runner))
            self.runs(home, [])
            (Path(runs) / 'metrics' / 'jobs.jsonl').write_text('not json\n{"event":"finish"}\n')
            self.assertIsNone(precheck('RQ-TEST', 'phantom', 'RQ-TEST (P0): repair',
                                       '/fixture', runs, runner))

    def test_upkeep_empty_same_base_never_reenqueues(self):
        script = Path(__file__).with_name('restock.py').resolve()
        with tempfile.TemporaryDirectory() as home:
            root = Path(home)
            queue = root / '.ashlr-runs/queue'
            (queue / 'prompts').mkdir(parents=True)
            metrics = root / '.ashlr-runs/metrics'
            metrics.mkdir()
            (queue / 'admission.json').write_text('{"cap": 10}')
            (queue / 'ready.tsv').write_text('')
            repo = root / 'Projects/ashlrai/phantom'
            repo.mkdir(parents=True)
            for args in (['init'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                                    'commit', '--allow-empty', '-m', 'base'],
                         ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
                         ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']):
                subprocess.run(['git', '-C', str(repo)] + args, check=True, capture_output=True)
            sha = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
            job = 'RQ-UPKEEP-REL-1'
            (queue / 'router-queue.md').write_text(f'- READY {job} (repo=phantom): maintenance\n')
            (metrics / 'jobs.jsonl').write_text(json.dumps(dict(event='claim', job=job, repo='phantom', base_sha=sha)) + '\n' +
                                              json.dumps(dict(event='finish', job=job, empty=True, exit_code=0)) + '\n')
            env = dict(os.environ, HOME=home, PYTHONDONTWRITEBYTECODE='1')
            for _ in range(2):
                result = json.loads(subprocess.check_output(['python3', str(script), '--json'], env=env, text=True))
                self.assertEqual(result['queued'], 0)
                self.assertEqual(result['skips']['upkeep_empty_same_base'], 1)
            self.assertEqual((queue / 'ready.tsv').read_text(), '')


if __name__ == '__main__':
    unittest.main()
