"""Fixture tests for contrib/mac/staged_drain.py (RQ-SELFRUN-STAGED-DRAIN).

Every case builds a synthetic work dir in a temp HOME and invokes the repo copy
of staged_drain.py once (one tick) as a subprocess; nothing touches the real
/workspace/phantom-work, ~/.ashlr-runs or live GitHub. A stub `gh` serves queued
run counts from a file, a stub `publish.sh` records its argv, and a git guard
shim refuses any remote operation while delegating to real git, so the suite can
prove the drain never pushes. Covers: PARKED skip, .github/ and release* rows
routed to handoff, publish order, thresholds at 49/50/51 queued, poll failure,
done/failed marking, dry-run non-mutation and value-free per-row logging.
"""
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'staged_drain.py'
REAL_GIT = '/usr/bin/git'
REPOS = ['locus', 'lexicon', 'ashlr-md', 'ashlr-stack', 'ashlr-plugin']

GH_STUB = '''#!/bin/bash
echo "$*" >> "$HOME/gh-argv.log"
f="$HOME/gh-counts"
[ -f "$f" ] || exit 1
head -n 1 "$f" | grep -qxE '[0-9]+' || exit 1
out=$(head -n 1 "$f")
tail -n +2 "$f" > "$f.tmp"; mv "$f.tmp" "$f"
echo "$out"
'''

GIT_GUARD = '''#!/bin/bash
echo "$*" >> "$HOME/git-argv.log"
for a in "$@"; do
  case "$a" in push|fetch|pull|clone|remote|ls-remote|send-pack|receive-pack|submodule) exit 99;; esac
done
exec /usr/bin/git "$@"
'''

PUBLISH_STUB = '''#!/bin/bash
echo "$*" >> "$HOME/publish-argv.log"
if [ -f "$HOME/publish-fail" ]; then
  while IFS= read -r j; do [ "$j" = "$1" ] && exit 7; done < "$HOME/publish-fail"
fi
exit 0
'''


def write(path, text, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


def build(tsv=None, counts=None, publish_fail=()):
    """temp HOME with work/, stubbin/gh + git guard, mac-bridge/publish.sh stub."""
    tmp = tempfile.TemporaryDirectory()
    home = Path(tmp.name)
    (home / 'work' / 'handoff').mkdir(parents=True)
    if tsv is not None:
        (home / 'work' / 'staged-pushes.tsv').write_text(tsv)
    write(home / 'stubbin' / 'gh', GH_STUB, 0o755)
    write(home / 'stubbin' / 'git-guard', GIT_GUARD, 0o755)
    write(home / 'mac-bridge' / 'publish.sh', PUBLISH_STUB, 0o755)
    if counts is not None:
        (home / 'gh-counts').write_text(''.join('%d\n' % c for c in counts))
    if publish_fail:
        (home / 'publish-fail').write_text(''.join(j + '\n' for j in publish_fail))
    return tmp


def tick(home, *args, env_extra=None):
    env = {'HOME': str(home),
           'PATH': str(Path(home) / 'stubbin') + ':' + os.environ.get('PATH', '/usr/bin:/bin'),
           'LANG': 'C',
           'STAGED_DRAIN_WORK': str(Path(home) / 'work'),
           'STAGED_DRAIN_PUBLISH': str(Path(home) / 'mac-bridge' / 'publish.sh'),
           'STAGED_DRAIN_GIT': str(Path(home) / 'stubbin' / 'git-guard'),
           'STAGED_DRAIN_SCRUB': str(Path(home) / 'no-such-scrub.pl')}
    if env_extra:
        env.update(env_extra)
    return subprocess.run([sys.executable, '-B', str(SCRIPT), *args], env=env,
                          capture_output=True, text=True, timeout=120)


def tsv(home):
    f = Path(home) / 'work' / 'staged-pushes.tsv'
    return f.read_text() if f.exists() else ''


def publish_calls(home):
    f = Path(home) / 'publish-argv.log'
    return f.read_text().splitlines() if f.exists() else []


def git_calls(home):
    f = Path(home) / 'git-argv.log'
    return f.read_text().splitlines() if f.exists() else []


def row_lines(out):
    return [l for l in out.splitlines() if ' STAGED_DRAIN row=' in l]


def mk_wt(home, name, files):
    """Real git repo with a base commit plus uncommitted staged content."""
    wt = Path(os.path.realpath(Path(home) / 'wts' / name))
    wt.mkdir(parents=True)
    env = {'HOME': str(home), 'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C'}
    def g(*a):
        return subprocess.run([REAL_GIT, '-C', str(wt), *a], env=env,
                              capture_output=True, text=True, timeout=60)
    g('init', '-q')
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base')
    base = g('rev-parse', 'HEAD').stdout.strip()
    for rel, content in files.items():
        p = wt / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    return str(wt), base


LOW = [2, 2, 2, 2, 2]   # total queued = 10, below the 50 threshold


class GateTests(unittest.TestCase):
    def test_49_drains(self):
        tmp = build(tsv='JOB-A\tlocus\t/nonexistent\tabc1234\tstaged\tsrc/a.ts\n',
                    counts=[10, 10, 10, 10, 9])
        with tmp:
            r = tick(Path(tmp.name))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('drain=proceed', r.stdout)
            self.assertIn('queued=49', r.stdout)
            self.assertEqual(publish_calls(tmp.name), ['JOB-A'])
            self.assertIn('JOB-A\tlocus\t/nonexistent\tabc1234\tdone', tsv(tmp.name))

    def test_50_holds(self):
        src = 'JOB-A\tlocus\t/nonexistent\tabc1234\tstaged\tsrc/a.ts\n'
        tmp = build(tsv=src, counts=[10, 10, 10, 10, 10])
        with tmp:
            r = tick(Path(tmp.name))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('queued=50', r.stdout)
            self.assertIn('drain=hold', r.stdout)
            self.assertEqual(publish_calls(tmp.name), [])
            self.assertEqual(tsv(tmp.name), src)

    def test_51_holds(self):
        src = 'JOB-A\tlocus\t/nonexistent\tabc1234\tstaged\tsrc/a.ts\n'
        tmp = build(tsv=src, counts=[11, 10, 10, 10, 10])
        with tmp:
            r = tick(Path(tmp.name))
            self.assertIn('queued=51', r.stdout)
            self.assertIn('drain=hold', r.stdout)
            self.assertEqual(publish_calls(tmp.name), [])
            self.assertEqual(tsv(tmp.name), src)

    def test_poll_failure_holds(self):
        src = 'JOB-A\tlocus\t/nonexistent\tabc1234\tstaged\tsrc/a.ts\n'
        tmp = build(tsv=src, counts=None)
        with tmp:
            r = tick(Path(tmp.name))
            self.assertIn('poll=failed', r.stdout)
            self.assertIn('drain=hold', r.stdout)
            self.assertEqual(publish_calls(tmp.name), [])
            self.assertEqual(tsv(tmp.name), src)

    def test_no_tsv_is_idle_and_never_polls(self):
        tmp = build(tsv=None, counts=LOW)
        with tmp:
            r = tick(Path(tmp.name))
            self.assertIn('staged=0', r.stdout)
            self.assertIn('drain=idle', r.stdout)
            self.assertFalse((Path(tmp.name) / 'gh-argv.log').exists())

    def test_all_terminal_is_idle_and_never_polls(self):
        tmp = build(tsv='JOB-A\tlocus\t/nonexistent\tabc1234\tdone\tsrc/a.ts\n'
                        'JOB-B\tlocus\t/nonexistent\tabc1234\tPARKED\tsrc/b.ts\n',
                    counts=LOW)
        with tmp:
            r = tick(Path(tmp.name))
            self.assertIn('staged=0', r.stdout)
            self.assertFalse((Path(tmp.name) / 'gh-argv.log').exists())


class DryRunTests(unittest.TestCase):
    TSV = ('# staged pushes fixture\n'
           'JOB-A\tlocus\t/nonexistent\tabc1234\tstaged\tsrc/a.ts,docs/x.md\n'
           'JOB-PARK\tlocus\t/nonexistent\tabc1234\tPARKED\tsrc/p.ts\n'
           'JOB-GH\tlexicon\t/nonexistent\tabc1234\tstaged\t.github/workflows/w.yml\n'
           'JOB-REL\tashlr-md\t/nonexistent\tabc1234\tstaged\trelease.yml\n'
           'JOB-RELDIR\tashlr-stack\t/nonexistent\tabc1234\tstaged\tdocs/releases/notes.md\n'
           'JOB-DOT\tashlr-plugin\t/nonexistent\tabc1234\tstaged\t.release-please-manifest.json\n'
           'JOB-DONE\tlocus\t/nonexistent\tabc1234\tdone\tsrc/z.ts\n'
           'MALFORMED-LINE\n'
           'JOB-B\tlocus\t/nonexistent\tabc1234\tstaged\tsrc/b.ts\n')

    def test_dry_run_routes_and_order(self):
        tmp = build(tsv=self.TSV, counts=LOW)
        with tmp:
            r = tick(Path(tmp.name), '--dry-run')
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('drain=proceed', r.stdout)
            self.assertIn('dry-run', r.stdout)
            rows = row_lines(r.stdout)
            self.assertIn('job=JOB-A outcome=plan route=publish', rows[0])
            self.assertIn('job=JOB-PARK outcome=skipped route=parked', rows[1])
            self.assertIn('job=JOB-GH outcome=plan route=handoff', rows[2])
            self.assertIn('job=JOB-REL outcome=plan route=handoff', rows[3])
            self.assertIn('job=JOB-RELDIR outcome=plan route=handoff', rows[4])
            self.assertIn('job=JOB-DOT outcome=plan route=handoff', rows[5])
            self.assertIn('job=JOB-DONE outcome=skipped route=terminal', rows[6])
            self.assertIn('outcome=skipped reason=malformed', rows[7])
            self.assertIn('job=JOB-B outcome=plan route=publish', rows[8])
            # publish order follows file order
            pubs = [l for l in rows if 'route=publish' in l]
            self.assertTrue(pubs[0].index('JOB-A') < pubs[1].index('JOB-B'))
            # nothing mutates in dry-run
            self.assertEqual(tsv(tmp.name), self.TSV)
            self.assertEqual(publish_calls(tmp.name), [])
            self.assertEqual(git_calls(tmp.name), [])
            self.assertEqual(sorted(Path(tmp.name, 'work', 'handoff').iterdir()), [])


class DrainTests(unittest.TestCase):
    def test_parked_skipped_publish_in_order_done_marked(self):
        tmp = build(tsv='JOB-PARK\tlocus\t/nonexistent\tabc1234\tPARKED\tsrc/p.ts\n'
                        'JOB-A\tlocus\t/nonexistent\tabc1234\tstaged\tsrc/a.ts\n'
                        'JOB-B\tlexicon\t/nonexistent\tabc1234\tstaged\tsrc/b.ts\n',
                    counts=LOW)
        with tmp:
            r = tick(Path(tmp.name))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(publish_calls(tmp.name), ['JOB-A', 'JOB-B'])
            rows = row_lines(r.stdout)
            self.assertIn('job=JOB-PARK outcome=skipped route=parked', rows[0])
            self.assertIn('job=JOB-A outcome=done route=publish', rows[1])
            self.assertIn('job=JOB-B outcome=done route=publish', rows[2])
            out = tsv(tmp.name)
            self.assertIn('JOB-PARK\tlocus\t/nonexistent\tabc1234\tPARKED\tsrc/p.ts\n', out)
            self.assertIn('JOB-A\tlocus\t/nonexistent\tabc1234\tdone\tsrc/a.ts\troute=publish', out)
            self.assertIn('JOB-B\tlexicon\t/nonexistent\tabc1234\tdone\tsrc/b.ts\troute=publish', out)
            self.assertIn('done=2 failed=0 skipped=1', r.stdout)

    def test_handoff_creates_branch_and_diff_without_push(self):
        tmp = build(counts=LOW)
        with tmp:
            wt, base = mk_wt(tmp.name, 'ghwt', {'.github/workflows/w.yml': 'name: w\n'})
            src = 'JOB-GH\tlocus\t%s\t%s\tstaged\t.github/workflows/w.yml\n' % (wt, base)
            (Path(tmp.name) / 'work' / 'staged-pushes.tsv').write_text(src)
            r = tick(Path(tmp.name))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('job=JOB-GH outcome=done route=handoff', r.stdout)
            self.assertEqual(publish_calls(tmp.name), [])
            diff = Path(tmp.name) / 'work' / 'handoff' / 'JOB-GH.diff'
            self.assertTrue(diff.is_file())
            self.assertIn('.github/workflows/w.yml', diff.read_text())
            env = {'HOME': tmp.name, 'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C'}
            br = subprocess.run([REAL_GIT, '-C', wt, 'rev-parse', '--verify', 'staged-drain/JOB-GH'],
                                env=env, capture_output=True, text=True)
            self.assertEqual(br.returncode, 0)
            head = subprocess.run([REAL_GIT, '-C', wt, 'rev-parse', 'HEAD'],
                                  env=env, capture_output=True, text=True).stdout.strip()
            self.assertEqual(head, base)
            stat = subprocess.run([REAL_GIT, '-C', wt, 'status', '--porcelain'],
                                  env=env, capture_output=True, text=True).stdout
            self.assertIn('.github', stat)
            self.assertIn('JOB-GH\tlocus\t%s\t%s\tdone' % (wt, base), tsv(tmp.name))
            self.assertIn('route=handoff', tsv(tmp.name))
            # the git guard never saw a remote op
            for call in git_calls(tmp.name):
                self.assertNotRegex(call, r'\b(push|fetch|pull|clone|remote|ls-remote)\b')

    def test_underreported_github_drift_still_handoffs(self):
        tmp = build(counts=LOW)
        with tmp:
            wt, base = mk_wt(tmp.name, 'drift', {'.github/workflows/w.yml': 'name: w\n'})
            src = 'JOB-DRIFT\tlocus\t%s\t%s\tstaged\tsrc/a.ts\n' % (wt, base)
            (Path(tmp.name) / 'work' / 'staged-pushes.tsv').write_text(src)
            r = tick(Path(tmp.name))
            self.assertIn('job=JOB-DRIFT outcome=done route=handoff', r.stdout)
            self.assertEqual(publish_calls(tmp.name), [])
            self.assertTrue((Path(tmp.name) / 'work' / 'handoff' / 'JOB-DRIFT.diff').is_file())

    def test_publish_failure_marks_failed_and_continues(self):
        tmp = build(tsv='JOB-A\tlocus\t/nonexistent\tabc1234\tstaged\tsrc/a.ts\n'
                        'JOB-B\tlocus\t/nonexistent\tabc1234\tstaged\tsrc/b.ts\n',
                    counts=LOW, publish_fail=('JOB-A',))
        with tmp:
            r = tick(Path(tmp.name))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(publish_calls(tmp.name), ['JOB-A', 'JOB-B'])
            self.assertIn('job=JOB-A outcome=failed route=publish reason=publish-exit-7', r.stdout)
            self.assertIn('job=JOB-B outcome=done route=publish', r.stdout)
            out = tsv(tmp.name)
            self.assertIn('JOB-A\tlocus\t/nonexistent\tabc1234\tfailed\tsrc/a.ts\t'
                          'route=publish;reason=publish-exit-7', out)
            self.assertIn('JOB-B\tlocus\t/nonexistent\tabc1234\tdone', out)
            self.assertIn('done=1 failed=1 skipped=0', r.stdout)

    def test_invalid_rows_fail_closed(self):
        tmp = build(tsv='JOB-BAD\tnot-a-repo\t/nonexistent\tabc1234\tstaged\tsrc/a.ts\n'
                        'BAD ID\tlocus\t/nonexistent\tabc1234\tstaged\tsrc/a.ts\n'
                        'JOB-SHA\tlocus\t/nonexistent\tzzzzzzz\tstaged\tsrc/a.ts\n'
                        'JOB-NOPATHS\tlocus\t/nonexistent\tabc1234\tstaged\n',
                    counts=LOW)
        with tmp:
            r = tick(Path(tmp.name))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(publish_calls(tmp.name), [])
            self.assertIn('job=JOB-BAD outcome=failed route=none reason=repo-not-allowlisted', r.stdout)
            self.assertIn('job=BAD ID outcome=failed route=none reason=bad-job', r.stdout)
            self.assertIn('job=JOB-SHA outcome=failed route=none reason=bad-base', r.stdout)
            self.assertIn('job=JOB-NOPATHS outcome=failed route=none reason=paths-unavailable', r.stdout)
            self.assertIn('done=0 failed=4', r.stdout)

    def test_missing_publisher_fails_closed(self):
        tmp = build(tsv='JOB-A\tlocus\t/nonexistent\tabc1234\tstaged\tsrc/a.ts\n', counts=LOW)
        with tmp:
            (Path(tmp.name) / 'mac-bridge' / 'publish.sh').unlink()
            r = tick(Path(tmp.name))
            self.assertIn('reason=publisher-unavailable', r.stdout)
            self.assertIn('JOB-A\tlocus\t/nonexistent\tabc1234\tfailed', tsv(tmp.name))

    def test_held_lock_holds_tick(self):
        import fcntl
        src = 'JOB-A\tlocus\t/nonexistent\tabc1234\tstaged\tsrc/a.ts\n'
        tmp = build(tsv=src, counts=LOW)
        with tmp:
            lf = open(Path(tmp.name) / 'work' / 'staged-pushes.tsv.lock', 'w')
            fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                r = tick(Path(tmp.name))
            finally:
                lf.close()
            self.assertIn('lock=busy', r.stdout)
            self.assertIn('drain=hold', r.stdout)
            self.assertEqual(publish_calls(tmp.name), [])
            self.assertEqual(tsv(tmp.name), src)

    def test_logs_are_value_free(self):
        tmp = build(tsv='JOB-A\tlocus\t/secret/path\tabc1234\tstaged\tsrc/a.ts\n'
                        'JOB-PARK\tlocus\t/secret/path\tabc1234\tPARKED\tsrc/p.ts\n',
                    counts=LOW)
        with tmp:
            r = tick(Path(tmp.name))
            for line in r.stdout.splitlines():
                self.assertNotIn('/secret/path', line)
                self.assertNotIn('src/a.ts', line)
                self.assertNotIn('src/p.ts', line)
                self.assertNotIn('\u2014', line)
                self.assertNotIn('\u2013', line)


if __name__ == '__main__':
    unittest.main()
