"""Verify the frozen audit and proposed closures without network or mutations."""
import csv
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
before = json.loads((ROOT / 'before.json').read_text())
after = json.loads((ROOT / 'after.json').read_text())
pairs = json.loads((ROOT / 'closure-candidates.json').read_text())
revalidated = json.loads((ROOT / 'revalidation.json').read_text())
rows = list(csv.DictReader((ROOT.parent / 'pr-clear-1b.tsv').open(), delimiter='\t'))
conflicts = {p['number'] for p in before['records'] if p['mergeable'] is False}
assert len(before['records']) == len({p['number'] for p in before['records']})
assert {p['number'] for p in before['records']} == {p['number'] for p in after['records']}
assert len(rows) == len(conflicts) == len({r['pr'] for r in rows})
assert {int(r['pr']) for r in rows} == conflicts
assert not before['leaseHeld'] and not after['leaseHeld']
assert after['closedByThisRun'] == after['commentsPosted'] == after['publishedRecuts'] == 0
for pair in pairs:
    assert pair['allEqual'] and pair['noRenamePathsMatch']
    actual_paths = subprocess.check_output(
        ['git', 'diff', '--name-only', '--no-renames', pair['mergeBase'], pair['sourceHead'], '--'],
        cwd=ROOT.parent, text=True).splitlines()
    assert sorted(actual_paths) == sorted(pair['paths'])
    proof = next(p for p in revalidated['pairs'] if p['source'] == pair['source'])
    assert proof['sourceRevalidated'] and proof['carrierRevalidated']
    assert proof['sourceState'] == proof['carrierState'] == 'open'
    assert sorted(proof['patchFilenames']) == sorted(pair['paths'])
    for path in pair['paths']:
        def entry(sha):
            return subprocess.check_output(['git', 'ls-tree', '-z', sha, '--', path], cwd=ROOT.parent)
        assert entry(pair['sourceHead']) == entry(pair['carrierHead']), (pair['source'], path)
    draft = (ROOT / 'comments' / f"{pair['source']}.md").read_text()
    assert f"/pull/{pair['carrier']}" in draft and pair['sourceHead'] in draft and pair['carrierHead'] in draft
    assert '\u2014' not in draft
assert sum(r['proposed_action'] == 'CLOSE_SUPERSEDED' for r in rows) == len(pairs)
print(f"PASS audit: {len(before['records'])} open PRs, {len(rows)} conflict rows, {len(pairs)} exact supersession proofs; no remote mutations")
