import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDrain } from '../scripts/ci/merge-drain.mjs';

const repo = 'ashlrai/phantom';
const sha = (c = 'a') => c.repeat(40);
const noSleep = async () => {};

const fixture = (number, over = {}) => ({
  number,
  state: 'open', draft: false, auto_merge: { merge_method: 'squash' },
  base: { ref: 'master', repo: { full_name: repo } },
  head: { ref: `codex-bridge/RQ-${number}`, sha: sha('a'), repo: { full_name: repo } },
  mergeable: true, mergeable_state: 'behind',
  ...over,
});

// The pulls list endpoint carries no auto_merge/mergeable fields.
const row = (pr) => ({
  number: pr.number, state: pr.state, draft: pr.draft,
  base: pr.base, head: pr.head,
});

const httpError = (status) => Object.assign(new Error('provider refused'), { httpStatus: status });

// Sequences outcomes per attempt number (1-based); last entry repeats.
const seq = (...outcomes) => (attempt) => {
  const out = outcomes[Math.min(attempt - 1, outcomes.length - 1)];
  if (out instanceof Error) throw out;
  return out;
};

// Mocked provider: routes gh-args, counts attempts, tracks concurrency.
function hub({ pages = [[]], pulls = {}, puts = {} } = {}) {
  const calls = [];
  const attempts = { get: new Map(), put: new Map(), list: new Map() };
  let inFlight = 0;
  let maxInFlight = 0;
  const bump = (map, key) => {
    const n = (map.get(key) ?? 0) + 1;
    map.set(key, n);
    return n;
  };
  const resolve = (handler, attempt) => {
    const out = typeof handler === 'function' ? handler(attempt) : handler;
    if (out instanceof Error) throw out;
    return out;
  };
  const call = async (args) => {
    calls.push(args);
    inFlight += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    try {
      await Promise.resolve();
      const target = args.find((a) => typeof a === 'string' && a.startsWith('repos/'));
      if (target.includes('/pulls?')) {
        const page = Number((/[?&]page=(\d+)/.exec(target) ?? [])[1]);
        return resolve(pages[page - 1] ?? [], bump(attempts.list, page));
      }
      const number = Number(/\/pulls\/(\d+)/.exec(target)[1]);
      if (target.endsWith('/update-branch')) {
        return resolve(puts[number] ?? {}, bump(attempts.put, number));
      }
      const out = resolve(pulls[number], bump(attempts.get, number));
      if (out === undefined) throw new Error(`no fixture for PR ${number}`);
      return out;
    } finally {
      inFlight -= 1;
    }
  };
  return { call, calls, attempts, maxInFlight: () => maxInFlight };
}

const byNumber = (report) => Object.fromEntries(report.prs.map((r) => [r.number, r.status]));
const drain = (h, options = {}) => mergeDrain(repo, { call: h.call, sleep: noSleep, ...options });

const mutationCalls = (calls) => calls.filter((args) => {
  const i = args.indexOf('--method');
  return i !== -1 && args[i + 1] !== 'GET';
});

test('eligibility: only in-scope PRs are fetched; only eligible behind heads are updated', async () => {
  const behind = fixture(10);
  const noAuto = fixture(11, { auto_merge: null });
  const rows = [
    behind, noAuto,
    fixture(12, { draft: true }),
    fixture(13, { head: { ...fixture(13).head, repo: { full_name: 'other/phantom' } } }),
    fixture(14, { head: { ...fixture(14).head, ref: 'release-please--x' } }),
    fixture(15, { base: { ...fixture(15).base, ref: 'other' } }),
    fixture(16, { state: 'closed' }),
  ];
  const h = hub({ pages: [rows.map(row)], pulls: { 10: behind, 11: noAuto } });
  const report = await drain(h);
  assert.equal(byNumber(report)[10], 'update-requested');
  assert.equal(h.attempts.put.size, 1);
  // Rows failing the cheap scope filter are never re-fetched individually.
  assert.deepEqual([...h.attempts.get.keys()].sort(), [10, 11]);
  for (const n of [11, 12, 13, 14, 15, 16]) {
    assert.equal(byNumber(report)[n], 'skipped');
  }
});

test('concurrency: in-flight provider calls never exceed the bound', async () => {
  const pulls = {};
  const rows = [];
  for (let n = 30; n < 38; n += 1) {
    pulls[n] = fixture(n);
    rows.push(row(fixture(n)));
  }
  const h = hub({ pages: [rows], pulls });
  const report = await drain(h, { concurrency: 3 });
  assert.equal(h.maxInFlight(), 3);
  assert.equal(h.attempts.put.size, 8);
  assert.equal(report.totals['update-requested'], 8);
});

test('concurrency: a bound of one serializes the drain', async () => {
  const pulls = { 40: fixture(40), 41: fixture(41), 42: fixture(42) };
  const h = hub({ pages: [[40, 41, 42].map((n) => row(pulls[n]))], pulls });
  await drain(h, { concurrency: 1 });
  assert.equal(h.maxInFlight(), 1);
});

test('bounded batches: update slots cap at --batch and the rest defer', async () => {
  const pulls = {};
  for (let n = 50; n < 55; n += 1) pulls[n] = fixture(n);
  const h = hub({ pages: [Object.values(pulls).map(row)], pulls });
  const report = await drain(h, { batch: 2, concurrency: 1 });
  const status = byNumber(report);
  assert.equal(status[50], 'update-requested');
  assert.equal(status[51], 'update-requested');
  for (const n of [52, 53, 54]) assert.equal(status[n], 'deferred');
  assert.equal(h.attempts.put.size, 2);
  assert.equal(report.totals.deferred, 3);
});

test('retries: a transient update failure retries the same head', async () => {
  const h = hub({
    pages: [[row(fixture(60))]],
    pulls: { 60: fixture(60) },
    puts: { 60: seq(httpError(502), {}) },
  });
  const report = await drain(h);
  assert.equal(byNumber(report)[60], 'update-requested');
  assert.equal(h.attempts.put.get(60), 2);
  assert.equal(h.attempts.get.get(60), 2);
});

test('retries: transient observation failures retry within the bound', async () => {
  const h = hub({
    pages: [[row(fixture(70))]],
    pulls: { 70: seq(httpError(502), httpError(429), fixture(70)) },
  });
  const report = await drain(h, { retries: 2 });
  assert.equal(byNumber(report)[70], 'update-requested');
  assert.equal(h.attempts.get.get(70), 3);
});

test('retries: exhausted transients and permanent failures report failed', async () => {
  const h = hub({
    pages: [[row(fixture(80)), row(fixture(81)), row(fixture(82))]],
    pulls: {
      80: seq(httpError(502)),                       // exhausts 3 observes
      81: seq(httpError(403)),                       // permanent: no retry
      82: seq(fixture(82), fixture(82, { mergeable: false, mergeable_state: 'dirty' })),
    },
    puts: { 82: seq(httpError(422)) },               // permanent PUT refusal
  });
  const report = await drain(h, { retries: 2, concurrency: 1 });
  const status = byNumber(report);
  assert.equal(status[80], 'failed');
  assert.equal(status[81], 'failed');
  assert.equal(h.attempts.get.get(80), 3);
  assert.equal(h.attempts.get.get(81), 1);
  // 82: PUT 422 -> re-observe confirms same-head conflict -> conflict, no re-PUT.
  assert.equal(status[82], 'conflict');
  assert.equal(h.attempts.put.get(82), 1);
});

test('retries: update refusals that never resolve end failed, unknown states end pending', async () => {
  const h = hub({
    pages: [[row(fixture(90)), row(fixture(91))]],
    pulls: {
      90: fixture(90),                                // stays behind, PUT keeps failing
      91: fixture(91, { mergeable: null, mergeable_state: 'unknown' }),
    },
    puts: { 90: seq(httpError(502)) },
  });
  const report = await drain(h, { retries: 2, concurrency: 1 });
  const status = byNumber(report);
  assert.equal(status[90], 'failed');
  assert.equal(status[91], 'pending');
  assert.equal(h.attempts.put.get(90), 3);
  assert.equal(h.attempts.get.get(91), 3);
});

test('per-PR outcomes: green PRs are already in the merge queue and never mutated', async () => {
  const clean = fixture(100, { mergeable: true, mergeable_state: 'clean' });
  const unstable = fixture(101, { mergeable: true, mergeable_state: 'unstable' });
  const blocked = fixture(102, { mergeable: true, mergeable_state: 'blocked' });
  const dirty = fixture(103, { mergeable: false, mergeable_state: 'dirty' });
  const h = hub({
    pages: [[clean, unstable, blocked, dirty].map(row)],
    pulls: { 100: clean, 101: unstable, 102: blocked, 103: dirty },
  });
  const report = await drain(h);
  const status = byNumber(report);
  assert.equal(status[100], 'queued');
  assert.equal(status[101], 'queued');
  assert.equal(status[102], 'blocked');
  assert.equal(status[103], 'conflict');
  // Green/queued/conflicted PRs enter or report through the existing merge
  // queue only: the drain issues no mutation calls for any of them.
  assert.equal(mutationCalls(h.calls).length, 0);
  const conflict = report.prs.find((r) => r.number === 103);
  assert.equal(conflict.ask.schema, 'ask.v1');
  assert.match(conflict.ask.id, /^RQ-RECUT-/);
  assert.match(conflict.ask.task, /recut/);
});

test('conflicts are reported without closing, merging, or patching the PR', async () => {
  const h = hub({
    pages: [[row(fixture(110))]],
    pulls: { 110: fixture(110, { mergeable: false, mergeable_state: 'dirty' }) },
  });
  const report = await drain(h);
  assert.equal(report.prs[0].status, 'conflict');
  // Every call is a plain GET observation: no merge, close, delete or patch.
  assert.equal(mutationCalls(h.calls).length, 0);
  assert.ok(!h.calls.some((args) => args.some((a) =>
    /\/merge$|state=closed|DELETE|PATCH|POST/.test(a))));
});

test('a concurrently moved head reports head-moved instead of updating a new revision', async () => {
  const h = hub({
    pages: [[row(fixture(120))]],
    pulls: {
      120: seq(
        fixture(120),
        fixture(120, { head: { ...fixture(120).head, sha: sha('b') } }),
      ),
    },
    puts: { 120: seq(httpError(502)) },
  });
  const report = await drain(h, { retries: 2 });
  assert.equal(report.prs[0].status, 'head-moved');
  assert.equal(report.prs[0].headSha, sha('b'));
  assert.equal(h.attempts.put.get(120), 1);
});

test('invalid head SHA reports failed before any mutation', async () => {
  const h = hub({
    pages: [[row(fixture(130))]],
    pulls: { 130: fixture(130, { head: { ...fixture(130).head, sha: 'bad' } }) },
  });
  const report = await drain(h);
  assert.deepEqual(report.prs[0], { number: 130, status: 'failed', reason: 'head-sha' });
  assert.equal(mutationCalls(h.calls).length, 0);
});

test('listing paginates to the limit and fails the run on refusal', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => row(fixture(200 + i)));
  const page2 = [row(fixture(300)), row(fixture(301))];
  const pulls = Object.fromEntries([...page1, ...page2].map((r) => [r.number, fixture(r.number)]));
  const h = hub({ pages: [page1, page2], pulls });
  const report = await drain(h, { limit: 200, batch: 200 });
  assert.equal(report.scanned, 102);
  assert.equal(h.attempts.list.get(1), 1);
  assert.equal(h.attempts.list.get(2), 1);

  const limited = hub({ pages: [page1, page2], pulls });
  const capped = await drain(limited, { limit: 50 });
  assert.equal(capped.scanned, 50);
  assert.equal(limited.attempts.list.get(2) ?? 0, 0);

  const refused = hub({ pages: [httpError(403)] });
  await assert.rejects(drain(refused), /Unable to list open pull requests/);
});

test('rejects malformed input before invoking the provider', async () => {
  const call = async () => assert.fail('provider called');
  for (const target of ['other/repo', 'ashlrai', 'ashlrai/UPPER']) {
    await assert.rejects(mergeDrain(target, { call, sleep: noSleep }));
  }
  for (const bad of [{ limit: 0 }, { batch: -1 }, { concurrency: 0 }, { retries: -1 },
    { concurrency: 99 }, { retries: 99 }, { batch: 1.5 }]) {
    await assert.rejects(mergeDrain(repo, { call, sleep: noSleep, ...bad }));
  }
});

test('report totals cover every scanned PR', async () => {
  const pulls = {
    140: fixture(140, { mergeable: true, mergeable_state: 'clean' }),
    141: fixture(141),
    142: fixture(142, { mergeable: false, mergeable_state: 'dirty' }),
  };
  const h = hub({
    pages: [[...[140, 141, 142].map((n) => row(pulls[n])), row(fixture(143, { draft: true }))]],
    pulls,
  });
  const report = await drain(h);
  assert.equal(report.repo, repo);
  assert.equal(report.candidates, 3);
  const sum = Object.values(report.totals).reduce((a, b) => a + b, 0);
  assert.equal(sum, report.scanned);
  assert.equal(report.totals.queued, 1);
  assert.equal(report.totals['update-requested'], 1);
  assert.equal(report.totals.conflict, 1);
  assert.equal(report.totals.skipped, 1);
  assert.deepEqual(report.prs.map((r) => r.number), [140, 141, 142, 143]);
});
