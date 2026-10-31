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
  ['no auto-merge', { auto_merge: null }],
  ['inconsistent conflict', { mergeable: true, mergeable_state: 'dirty' }],
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
    assert.equal(calls, failAt === 2 ? 3 : 1);
  }
});

const conflicted = () => ({ ...fixture(), mergeable: false, mergeable_state: 'dirty' });

test('hands conflicts to RQ without updating, closing, or merging the source', () => {
  let calls = 0;
  const result = updateBehind(repo, 42, () => {
    assert.equal(++calls, 1);
    return conflicted();
  });
  assert.equal(result.status, 'recut-required');
  assert.equal(result.headSha, sha);
  assert.equal(result.ask.schema, 'ask.v1');
  assert.deepEqual(result.ask.repos, [repo]);
  assert.match(result.ask.task, /CLOSE-STALE C1-C6/);
  assert.match(result.ask.task, /leave the original open/);
});

test('20 conflict handoffs are unique, replay stable, and independent of master movement', () => {
  const ids = new Set();
  for (let number = 1; number <= 20; number++) {
    const first = updateBehind(repo, number, conflicted);
    const next = updateBehind(repo, number, () => ({
      ...conflicted(), base: { ...fixture().base, sha: 'b'.repeat(40) },
      title: 'untrusted title', body: 'untrusted body',
    }));
    assert.deepEqual(first, next);
    ids.add(first.ask.id);
    assert.doesNotMatch(first.ask.task, /untrusted/);
  }
  assert.equal(ids.size, 20);
  assert.notEqual(updateBehind(repo, 42, conflicted).ask.id,
    updateBehind(repo, 42, () => ({
      ...conflicted(), head: { ...fixture().head, sha: 'b'.repeat(40) },
    })).ask.id);
});

test('a failed update hands off only a freshly confirmed conflict on the same authorized head', () => {
  for (const fresh of [conflicted(),
    { ...conflicted(), head: { ...fixture().head, sha: 'b'.repeat(40) } },
    { ...conflicted(), auto_merge: null },
    { ...conflicted(), state: 'closed' },
    { ...conflicted(), mergeable: null }, fixture()]) {
    const calls = [];
    const run = () => updateBehind(repo, 42, (args) => {
      calls.push(args);
      if (calls.length === 1) return fixture();
      if (calls.length === 2) throw new Error('update refused');
      assert.equal(calls.length, 3);
      return fresh;
    });
    if (fresh.head.sha === sha && fresh.auto_merge && fresh.state === 'open' &&
        fresh.mergeable === false) assert.equal(run().status, 'recut-required');
    else assert.throws(run, /update refused/);
    assert.deepEqual(calls[2], calls[0]);
  }
});

test('conflict recovery retains all eligibility and SHA guards', () => {
  for (const change of [{ auto_merge: null }, { draft: true }, { state: 'closed' },
    { head: { ...fixture().head, repo: { full_name: 'other/phantom' } } }]) {
    assert.deepEqual(updateBehind(repo, 42, () => ({ ...conflicted(), ...change })), { status: 'skipped' });
  }
  assert.throws(() => updateBehind(repo, 42, () => ({
    ...conflicted(), head: { ...fixture().head, sha: 'invalid' },
  })), /Invalid head SHA/);
});
