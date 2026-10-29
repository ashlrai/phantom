import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateBehind } from './update-behind.mjs';

const repo = 'ashlrai/phantom';
const sha = 'a'.repeat(40);
const fixture = () => ({
  state: 'open', draft: false, auto_merge: { merge_method: 'squash' },
  base: { ref: 'master', repo: { full_name: repo } },
  head: { ref: 'codex-bridge/RQ-FIXUP', sha, repo: { full_name: repo } },
  mergeable: true, mergeable_state: 'behind',
});

test('updates a behind bridge PR using a compare-and-swap head', () => {
  const calls = [];
  assert.deepEqual(updateBehind(repo, 42, (args) => {
    calls.push(args);
    return calls.length === 1 ? fixture() : {};
  }), { status: 'update-requested', headSha: sha });
  assert.deepEqual(calls, [
    ['api', 'repos/ashlrai/phantom/pulls/42'],
    ['api', '--method', 'PUT', 'repos/ashlrai/phantom/pulls/42/update-branch',
      '-f', `expected_head_sha=${sha}`],
  ]);
});

for (const [label, change] of [
  ['closed', { state: 'closed' }], ['draft', { draft: true }],
  ['no auto-merge', { auto_merge: null }], ['conflicts', { mergeable: false, mergeable_state: 'dirty' }],
  ['unknown', { mergeable: null }], ['current', { mergeable_state: 'clean' }],
  ['blocked', { mergeable_state: 'blocked' }],
  ['fork', { head: { ...fixture().head, repo: { full_name: 'other/phantom' } } }],
  ['release', { head: { ...fixture().head, ref: 'release-please--branches--master' } }],
  ['wrong base', { base: { ...fixture().base, ref: 'other' } }],
  ['wrong repository', { base: { ...fixture().base, repo: { full_name: 'other/phantom' } } }],
]) {
  test(`skips ${label} without a mutation`, () => {
    let calls = 0;
    assert.deepEqual(updateBehind(repo, 42, () => {
      assert.equal(++calls, 1);
      return { ...fixture(), ...change };
    }), { status: 'skipped' });
  });
}

test('rejects malformed inputs before invoking the provider', () => {
  for (const [target, number] of [['other/repo', 42], [repo, '-1'], [repo, '42/merge']]) {
    assert.throws(() => updateBehind(target, number, () => assert.fail('provider called')));
  }
});

test('invalid head SHA fails before mutation', () => {
  let calls = 0;
  assert.throws(() => updateBehind(repo, 42, () => {
    assert.equal(++calls, 1);
    return { ...fixture(), head: { ...fixture().head, sha: 'bad' } };
  }), /Invalid head SHA/);
});

test('provider and concurrent head failures propagate without retrying', () => {
  for (const failAt of [1, 2]) {
    let calls = 0;
    assert.throws(() => updateBehind(repo, 42, () => {
      if (++calls === failAt) throw new Error('provider refused');
      return fixture();
    }), /provider refused/);
    assert.equal(calls, failAt);
  }
});
