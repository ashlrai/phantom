import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('retires a recut only for matching current-head conflict evidence', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const output = execFileSync('python3', ['-B', '-c', `
import json
import subprocess
import sys
import tempfile
sys.path.insert(0, 'contrib/mac')
from launch_precheck import repair_freshness

job = 'RQ-RECUT-phantom-42-abcdef0'
calls = []
payload = {'number': 42, 'state': 'OPEN', 'headRefOid': 'abcdef0' + '1' * 33,
           'mergeable': 'MERGEABLE'}
def runner(argv, timeout, **kwargs):
    calls.append({'argv': argv, 'timeout': timeout, 'cwd': kwargs['cwd']})
    return subprocess.CompletedProcess(argv, 0, json.dumps(payload), '')
with tempfile.TemporaryDirectory() as home:
    resolved = repair_freshness(job, 'phantom', '', home, runner)
    payload['headRefOid'] = 'f' * 40
    moved = repair_freshness(job, 'phantom', '', home, runner)
    payload['headRefOid'] = 'abcdef0' + '1' * 33
    payload['mergeable'] = 'UNKNOWN'
    unknown = repair_freshness(job, 'phantom', '', home, runner)
    invalid = repair_freshness(job, '../phantom', '', home, runner)
    print(json.dumps({'results': [resolved, moved, unknown, invalid],
                      'calls': len(calls), 'bounded': all(c['timeout'] == 3 for c in calls),
                      'scoped': all(c['cwd'] == home and c['argv'][:4] == ['locus', 'exec', '--', 'gh']
                                    and c['argv'][8] == 'ashlrai/phantom' for c in calls)}))
`], { cwd: root, encoding: 'utf8', timeout: 5_000 });
  expect(JSON.parse(output)).toEqual({
    results: ['target_pr_conflicts_resolved', null, null, null],
    calls: 3, bounded: true, scoped: true,
  });
});
