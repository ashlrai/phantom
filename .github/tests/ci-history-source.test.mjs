import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import process from 'node:process';
import { URL } from 'node:url';
import { parse } from 'yaml';
import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';

import { HistoryProofFallback, proveHistoryFastPath, githubApiRead } from '../scripts/ci-history-source.mjs';

const REPO = 'ashlrai/phantom';
const REPO_ID = 1263526319;
const OWNER_ID = 258113726;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeRepo(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-history-source-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'ci-history-test');
  git(cwd, 'config', 'user.email', 'ci-history-test@example.invalid');
  writeFileSync(join(cwd, 'tracked.txt'), 'base\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  const baseTree = git(cwd, 'rev-parse', 'HEAD^{tree}');
  git(cwd, 'commit', '-qm', 'candidate', '--allow-empty');
  const candidate = git(cwd, 'rev-parse', 'HEAD');
  return { cwd, base, baseTree, candidate };
}

function eventFile(t, payload) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-history-event-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'event.json');
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

function baseEnv(t, { eventName, eventSha, payload, workspace }) {
  return {
    GITHUB_EVENT_NAME: eventName,
    GITHUB_SHA: eventSha,
    GITHUB_REF: eventName === 'pull_request' ? `refs/pull/${payload?.pull_request?.number ?? 42}/merge` : payload?.merge_group?.head_ref,
    ASHLR_HISTORY_PROOF_SOURCE_SHA: payload?.pull_request?.base?.sha ?? payload?.merge_group?.base_sha,
    GITHUB_REPOSITORY: REPO,
    GITHUB_REPOSITORY_ID: String(REPO_ID),
    GITHUB_REPOSITORY_OWNER_ID: String(OWNER_ID),
    GITHUB_EVENT_PATH: eventFile(t, payload),
    GITHUB_WORKSPACE: workspace,
    GH_TOKEN: 'test-token',
  };
}

const repoMetadata = {
  id: REPO_ID, node_id: 'R_kgDOS0_hrw', name: 'phantom', full_name: REPO,
  owner: { login: 'ashlrai', id: OWNER_ID }, default_branch: 'master',
  private: false, visibility: 'public',
};

function apiFixture({ base, baseTree, candidate, candidateTree = baseTree, tip = base, eventSha, eventTree, eventParents, repo = repoMetadata, calls = [] }) {
  const commits = {
    [base]: { sha: base, tree: { sha: baseTree }, parents: [{ sha: '0'.repeat(40) }] },
    [candidate]: { sha: candidate, tree: { sha: candidateTree }, parents: eventParents ?? [{ sha: base }] },
  };
  if (eventSha && eventSha !== candidate && eventSha !== base) {
    commits[eventSha] = {
      sha: eventSha,
      tree: { sha: eventTree ?? baseTree },
      parents: eventParents ?? [{ sha: base }, { sha: candidate }],
    };
  }
  return async (path) => {
    calls.push(path);
    if (path === `repos/${REPO}`) return repo;
    if (path === `repos/${REPO}/branches/master`) return { name: 'master', protected: true, commit: { sha: tip } };
    if (path === `repos/${REPO}/git/ref/heads/master`) {
      return { ref: 'refs/heads/master', object: { sha: tip, type: 'commit' } };
    }
    const commitMatch = path.match(new RegExp(`^repos/${REPO}/git/commits/([0-9a-f]{40})$`));
    if (commitMatch) {
      const commit = commits[commitMatch[1]];
      if (!commit) throw new Error(`unexpected commit ${commitMatch[1]}`);
      return commit;
    }
    throw new Error(`unexpected API path ${path}`);
  };
}

const prPayload = ({ head = 'c'.repeat(40), base = 'b'.repeat(40), headRepo = { id: 42 }, baseRepo = { id: REPO_ID }, baseRef = 'master' } = {}) => ({
  pull_request: {
    number: 42,
    head: { sha: head, repo: headRepo },
    base: { sha: base, ref: baseRef, repo: baseRepo },
  },
});

const mgPayload = ({ headSha, baseSha, baseRef = 'refs/heads/master' }) => ({
  merge_group: { head_sha: headSha, base_sha: baseSha, base_ref: baseRef, head_ref: `refs/heads/gh-readonly-queue/master/pr-42-${headSha}` },
});

async function expectFallback(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HistoryProofFallback, `expected HistoryProofFallback, got ${error}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test('pull_request with an equal tracked tree proves equal with candidate checkout', async (t) => {
  const repo = makeRepo(t);
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base }),
    workspace: repo.cwd,
  });
  const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
  assert.equal(await proveHistoryFastPath({ env, api, root: repo.cwd }), 'equal');
});

test('pull_request synthetic merge event binds exact base/head parents and base tree', async (t) => {
  const repo = makeRepo(t);
  const eventSha = 'e'.repeat(40);
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha,
    payload: prPayload({ head: repo.candidate, base: repo.base }),
    workspace: repo.cwd,
  });
  const api = apiFixture({
    base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate,
    eventSha, eventTree: repo.baseTree, eventParents: [{ sha: repo.base }, { sha: repo.candidate }],
  });
  assert.equal(await proveHistoryFastPath({ env, api, root: repo.cwd }), 'equal');
});

test('merge_group generated commit proves equal without requiring head equality with a PR', async (t) => {
  const repo = makeRepo(t);
  const env = baseEnv(t, {
    eventName: 'merge_group', eventSha: repo.candidate,
    payload: mgPayload({ headSha: repo.candidate, baseSha: repo.base }),
    workspace: repo.cwd,
  });
  const api = apiFixture({
    base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate,
    eventParents: [{ sha: repo.base }, { sha: 'f'.repeat(40) }],
  });
  assert.equal(await proveHistoryFastPath({ env, api, root: repo.cwd }), 'equal');
});

test('fork pull_request head with foreign repository identity still proves equal', async (t) => {
  const repo = makeRepo(t);
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base, headRepo: { id: 999999 } }),
    workspace: repo.cwd,
  });
  const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
  assert.equal(await proveHistoryFastPath({ env, api, root: repo.cwd }), 'equal');
});

test('non-fast events refuse before any API or git work', async (t) => {
  const repo = makeRepo(t);
  const calls = [];
  const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate, calls });
  const env = baseEnv(t, {
    eventName: 'push', eventSha: repo.candidate,
    payload: {}, workspace: repo.cwd,
  });
  await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }));
  assert.deepEqual(calls, []);
});

test('malformed and short revisions refuse', async (t) => {
  const repo = makeRepo(t);
  for (const [label, mutate] of [
    ['short head', (p) => { p.pull_request.head.sha = 'abc123'; }],
    ['non-hex base', (p) => { p.pull_request.base.sha = 'z'.repeat(40); }],
    ['short event sha', null],
  ]) {
    const payload = prPayload({ head: repo.candidate, base: repo.base });
    if (mutate) mutate(payload); else payload.pull_request.base.sha = repo.base.slice(0, 12);
    const env = baseEnv(t, {
      eventName: 'pull_request',
      eventSha: label === 'short event sha' ? 'abc' : repo.candidate,
      payload, workspace: repo.cwd,
    });
    const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
    await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }), /40-hex/);
  }
});

test('dirty tracked modification refuses', async (t) => {
  const repo = makeRepo(t);
  writeFileSync(join(repo.cwd, 'tracked.txt'), 'tampered\n');
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
  });
  const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
  await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }), /dirty/);
});

test('untracked file refuses', async (t) => {
  const repo = makeRepo(t);
  writeFileSync(join(repo.cwd, 'untracked.txt'), 'x\n');
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
  });
  const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
  await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }), /dirty/);
});

test('mode change refuses as dirty state', async (t) => {
  const repo = makeRepo(t);
  chmodSync(join(repo.cwd, 'tracked.txt'), 0o755);
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
  });
  const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
  await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }), /dirty/);
});

test('checkout HEAD differing from the candidate refuses', async (t) => {
  const repo = makeRepo(t);
  git(repo.cwd, 'checkout', '-q', repo.base);
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
  });
  const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
  await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }), /candidate revision/);
});

test('canonical base drift past the event base refuses', async (t) => {
  const repo = makeRepo(t);
  const drifted = 'd'.repeat(40);
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
  });
  const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate, tip: drifted });
  await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }), /advanced/);
});

test('candidate tree differing from the canonical base tree refuses', async (t) => {
  const repo = makeRepo(t);
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
  });
  const api = apiFixture({
    base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate,
    candidateTree: '9'.repeat(40),
  });
  await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }), /tree differs/);
});

test('checkout tree differing from the authenticated commit refuses', async (t) => {
  const repo = makeRepo(t);
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
  });
  const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
  const gitSpy = (args) => (args.join(' ') === 'rev-parse HEAD^{tree}' ? 'f'.repeat(40) : execFileSync('git', ['--no-optional-locks', '--no-replace-objects', ...args], { cwd: repo.cwd, encoding: 'utf8' }).trim());
  await expectFallback(proveHistoryFastPath({ env, api, git: gitSpy, root: repo.cwd }), /checkout tree/);
});

test('forged repository identity refuses', async (t) => {
  const repo = makeRepo(t);
  const cases = [
    [{ ...repoMetadata, id: 1 }, /identity/],
    [{ ...repoMetadata, owner: { login: 'mallory', id: OWNER_ID } }, /identity/],
    [{ ...repoMetadata, default_branch: 'trunk' }, /identity/],
    [{ ...repoMetadata, private: true }, /identity/],
    [{ ...repoMetadata, visibility: 'internal' }, /identity/],
  ];
  for (const [meta, pattern] of cases) {
    const env = baseEnv(t, {
      eventName: 'pull_request', eventSha: repo.candidate,
      payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
    });
    const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate, repo: meta });
    await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }), pattern);
  }
});

test('wrong producer environment refuses', async (t) => {
  const repo = makeRepo(t);
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
  });
  env.GITHUB_REPOSITORY = 'attacker/repo';
  env.GITHUB_REPOSITORY_ID = '1';
  const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
  await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }));
});

test('API unavailability and malformed responses refuse', async (t) => {
  const repo = makeRepo(t);
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
  });
  await expectFallback(proveHistoryFastPath({ env, api: async () => { throw new Error('HTTP 503'); }, root: repo.cwd }));
  await expectFallback(proveHistoryFastPath({ env, api: async (path) => path === `repos/${REPO}` ? null : {}, root: repo.cwd }));
  const missingCommit = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
  const wrapped = async (path) => {
    if (path.endsWith(`/git/commits/${repo.candidate}`)) throw new Error('HTTP 404');
    return missingCommit(path);
  };
  await expectFallback(proveHistoryFastPath({ env, api: wrapped, root: repo.cwd }), /unavailable/);
});

test('missing API token refuses through the default reader', async (t) => {
  const repo = makeRepo(t);
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.candidate }), workspace: repo.cwd,
  });
  delete env.GH_TOKEN;
  await expectFallback(proveHistoryFastPath({ env, root: repo.cwd }), /token/);
});

test('pull request base outside the default branch or foreign base repo refuses', async (t) => {
  const repo = makeRepo(t);
  for (const [payload, pattern] of [
    [prPayload({ head: repo.candidate, base: repo.base, baseRef: 'release' }), /default branch/],
    [prPayload({ head: repo.candidate, base: repo.base, baseRepo: { id: 7 } }), /base repository/],
  ]) {
    const env = baseEnv(t, {
      eventName: 'pull_request', eventSha: repo.candidate,
      payload, workspace: repo.cwd,
    });
    const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
    await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }), pattern);
  }
});

test('merge_group head/base/ref binding mismatches refuse', async (t) => {
  const repo = makeRepo(t);
  const cases = [
    [mgPayload({ headSha: 'a'.repeat(40), baseSha: repo.base }), /event revision/],
    [mgPayload({ headSha: repo.candidate, baseSha: repo.base, baseRef: 'refs/heads/other' }), /base ref/],
    [mgPayload({ headSha: repo.candidate, baseSha: 'b'.repeat(7) }), /40-hex/],
  ];
  for (const [payload, pattern] of cases) {
    const env = baseEnv(t, {
      eventName: 'merge_group', eventSha: repo.candidate, payload, workspace: repo.cwd,
    });
    const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
    await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }), pattern);
  }
});

test('merge_group parents not rooted at the canonical base refuse', async (t) => {
  const repo = makeRepo(t);
  const env = baseEnv(t, {
    eventName: 'merge_group', eventSha: repo.candidate,
    payload: mgPayload({ headSha: repo.candidate, baseSha: repo.base }), workspace: repo.cwd,
  });
  const api = apiFixture({
    base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate,
    eventParents: [{ sha: 'c'.repeat(40) }, { sha: 'd'.repeat(40) }],
  });
  await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }), /parents/);
});

test('synthetic merge parent or tree mismatch refuses', async (t) => {
  const repo = makeRepo(t);
  const eventSha = 'e'.repeat(40);
  const makeEnv = () => baseEnv(t, {
    eventName: 'pull_request', eventSha,
    payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
  });
  const cases = [
    [{ eventTree: repo.baseTree, eventParents: [{ sha: repo.base }] }, /parents/],
    [{ eventTree: repo.baseTree, eventParents: [{ sha: repo.base }, { sha: 'f'.repeat(40) }] }, /parents/],
    [{ eventTree: '8'.repeat(40), eventParents: [{ sha: repo.base }, { sha: repo.candidate }] }, /merge tree/],
  ];
  for (const [overrides, pattern] of cases) {
    const api = apiFixture({
      base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate,
      eventSha, ...overrides,
    });
    await expectFallback(proveHistoryFastPath({ env: makeEnv(), api, root: repo.cwd }), pattern);
  }
});

test('missing or malformed event payload refuses', async (t) => {
  const repo = makeRepo(t);
  const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
  for (const payload of [{}, { pull_request: null }, { merge_group: null }, 'not-an-object']) {
    const env = baseEnv(t, {
      eventName: 'pull_request', eventSha: repo.candidate, payload, workspace: repo.cwd,
    });
    await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }));
  }
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
  });
  env.GITHUB_EVENT_PATH = join(repo.cwd, 'does-not-exist.json');
  await expectFallback(proveHistoryFastPath({ env, api, root: repo.cwd }));
});

test('git invocations stay read-only argv plumbing with hardening flags', async (t) => {
  const repo = makeRepo(t);
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
  });
  const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate });
  const seen = [];
  const gitSpy = (args) => {
    seen.push(args);
    return execFileSync('git', ['--no-optional-locks', '--no-replace-objects', ...args], { cwd: repo.cwd, encoding: 'utf8' }).trim();
  };
  assert.equal(await proveHistoryFastPath({ env, api, git: gitSpy, root: repo.cwd }), 'equal');
  const allowed = new Set(['rev-parse HEAD', 'rev-parse HEAD^{tree}', 'status --porcelain --untracked-files=normal']);
  for (const args of seen) {
    assert.ok(allowed.has(args.join(' ')), `unexpected git invocation ${args.join(' ')}`);
    assert.ok(args.every((arg) => typeof arg === 'string' && !arg.includes('$(') && !arg.includes(';')), 'unsafe git argument');
  }
});

test('API surface stays on canonical read endpoints only', async (t) => {
  const repo = makeRepo(t);
  const calls = [];
  const env = baseEnv(t, {
    eventName: 'pull_request', eventSha: repo.candidate,
    payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd,
  });
  const api = apiFixture({ base: repo.base, baseTree: repo.baseTree, candidate: repo.candidate, calls });
  assert.equal(await proveHistoryFastPath({ env, api, root: repo.cwd }), 'equal');
  for (const path of calls) {
    assert.match(path, /^repos\/ashlrai\/phantom(\/(branches\/master|git\/(ref\/heads\/master|commits\/[0-9a-f]{40})))?$/, `unexpected API path ${path}`);
  }
});

const jsonBody = (row) => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(row))); controller.close(); } });

test('default API reader never sends the existing token outside the exact official origin/read paths', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => { calls.push({ url, options }); return { ok: true, body: jsonBody({ ok: true }) }; };
  assert.deepEqual(await githubApiRead('repos/ashlrai/phantom', { GH_TOKEN: 'synthetic-token' }, fakeFetch), { ok: true });
  assert.equal(calls[0].url, 'https://api.github.com/repos/ashlrai/phantom');
  assert.equal(new URL(calls[0].url).origin, 'https://api.github.com');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.authorization, 'Bearer synthetic-token');
  for (const bad of ['repos/evil/repo', '//evil.invalid/x', 'repos/ashlrai/phantom?x=secret', 'repos/ashlrai/phantom/../other', 'repos/ashlrai/phantom/contents/x']) {
    await expectFallback(githubApiRead(bad, { GH_TOKEN: 'synthetic-token' }, fakeFetch), /API path/);
  }
  assert.equal(calls.length, 1);
});

test('exact PR ref and canonical helper-source pin are mandatory', async (t) => {
  const repo = makeRepo(t); const api = apiFixture(repo);
  for (const patch of [{ GITHUB_REF: 'refs/heads/master' }, { GITHUB_REF: 'refs/pull/43/merge' }, { GITHUB_REF: undefined }, { ASHLR_HISTORY_PROOF_SOURCE_SHA: 'f'.repeat(40) }, { ASHLR_HISTORY_PROOF_SOURCE_SHA: undefined }]) {
    const env = baseEnv(t, { eventName: 'pull_request', eventSha: repo.candidate, payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd });
    await expectFallback(proveHistoryFastPath({ env: { ...env, ...patch }, api, root: repo.cwd }));
  }
});

test('one-parent normal squash group is eligible, foreign or missing event refs refuse', async (t) => {
  const repo = makeRepo(t); const api = apiFixture(repo);
  const env = baseEnv(t, { eventName: 'merge_group', eventSha: repo.candidate, payload: mgPayload({ headSha: repo.candidate, baseSha: repo.base }), workspace: repo.cwd });
  assert.equal(await proveHistoryFastPath({ env, api, root: repo.cwd }), 'equal');
  for (const ref of [undefined, 'refs/heads/master', 'refs/heads/gh-readonly-queue/other/pr-42-'+repo.candidate]) {
    await expectFallback(proveHistoryFastPath({ env: { ...env, GITHUB_REF: ref }, api, root: repo.cwd }), /head ref/);
  }
});

test('unprotected branch or base movement during observation always falls back', async (t) => {
  const repo = makeRepo(t); const env = baseEnv(t, { eventName: 'pull_request', eventSha: repo.candidate, payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd });
  const normal = apiFixture(repo);
  await expectFallback(proveHistoryFastPath({ env, root: repo.cwd, api: async (path) => path.endsWith('/branches/master') ? { name: 'master', protected: false, commit: { sha: repo.base } } : normal(path) }), /protected branch/);
  let refs = 0;
  await expectFallback(proveHistoryFastPath({ env, root: repo.cwd, api: async (path) => path.endsWith('/ref/heads/master') && ++refs > 1 ? { ref: 'refs/heads/master', object: { sha: 'f'.repeat(40) } } : normal(path) }), /changed during proof/);
});

test('untrusted parse or API failures cannot print event bodies or private diagnostic payloads', async (t) => {
  const repo = makeRepo(t);
  const env = baseEnv(t, { eventName: 'pull_request', eventSha: repo.candidate, payload: prPayload({ head: repo.candidate, base: repo.base }), workspace: repo.cwd });
  await assert.rejects(proveHistoryFastPath({ env, root: repo.cwd, api: async () => { throw new Error('private-payload-marker'); } }), (error) => error.message === 'proof unavailable');
});

function executableNode(root, name, source) {
  const script = join(root, `${name}.cjs`); writeFileSync(script, source);
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const file = join(root, name); writeFileSync(file, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 });
}

test('actual bootstrap executes only immutable canonical-base code and safely falls back when it is unavailable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'history-bootstrap-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); mkdirSync(bin); const candidate = join(root, 'candidate'); mkdirSync(candidate);
  mkdirSync(join(candidate, '.github/scripts'), { recursive: true });
  const badMarker = join(root, 'candidate-executed');
  writeFileSync(join(candidate, '.github/scripts/ci-history-source.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(badMarker)},'bad');console.log('equal')`);
  executableNode(bin, 'timeout', `const cp=require('node:child_process');const a=process.argv.slice(2);if(!['20','75'].includes(a[0]))process.exit(3);const r=cp.spawnSync(a[1],a.slice(2),{stdio:'inherit',env:process.env,timeout:Number(a[0])*1000});process.exit(r.status??3);`);
  executableNode(bin, 'gh', `const fs=require('node:fs');const a=process.argv.slice(2);if(a.length!==4||a[0]!=='api'||a[1]!=='--hostname'||a[2]!=='github.com')process.exit(3);const p=a[3];fs.appendFileSync(process.env.TRACE,p+'\\n');const sha='a'.repeat(40);if(p==='repos/ashlrai/phantom/git/ref/heads/master'){console.log(JSON.stringify({object:{sha}}));process.exit(0)}if(!p.endsWith('?ref='+sha))process.exit(3);const name=p.split('/').pop().split('?')[0];if(process.env.MODE==='missing'&&name==='ci-history-source.mjs'){console.log('{}');process.exit(0)}const body=name==='ci-history-source.mjs'?"import fs from 'node:fs';fs.writeFileSync(process.env.BASE_MARKER,process.env.ASHLR_HISTORY_PROOF_SOURCE_SHA);console.log('equal');":"export const placeholder=1;";console.log(JSON.stringify({type:'file',encoding:'base64',content:Buffer.from(body).toString('base64')}));`);
  const workflow = parse(readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
  const script = workflow.jobs.quick.steps.find((row) => row.id === 'history').run;
  for (const mode of ['valid', 'missing', 'foreign-producer']) {
    const runner = join(root, mode); mkdirSync(runner); const output = join(runner, 'output'); const marker = join(runner, 'base'); const trace = join(runner, 'trace');
    const env = { HOME: root, USERPROFILE: root, PATH: bin+':'+dirname(process.execPath)+':/usr/bin:/bin', RUNNER_TEMP: runner, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: mode==='foreign-producer'?'evil/repo':'ashlrai/phantom', GITHUB_REPOSITORY_ID: String(REPO_ID), GITHUB_REPOSITORY_OWNER_ID: String(OWNER_ID), GH_TOKEN:'synthetic-only', GH_HOST:'evil.invalid', MODE:mode, BASE_MARKER:marker, TRACE:trace };
    execFileSync('/bin/bash', ['-c', script], { cwd:candidate, env, timeout:20_000, stdio:['ignore','pipe','pipe'] });
    assert.equal(readFileSync(output,'utf8'), mode==='valid'?'equal=true\n':'equal=false\n');
    assert.equal(existsSync(badMarker),false);
    if(mode==='valid')assert.equal(readFileSync(marker,'utf8'),'a'.repeat(40));else assert.equal(existsSync(marker),false);
    if(mode==='foreign-producer')assert.equal(existsSync(trace),false);
    else {const paths=readFileSync(trace,'utf8');assert.ok(paths.includes('?ref='+'a'.repeat(40)));assert.ok(!paths.includes('?ref=master'));}
  }
});

test('canonical ref must resolve to a commit object, never a tag-shaped or missing-type row', async (t) => {
  const repo=makeRepo(t);const env=baseEnv(t,{eventName:'pull_request',eventSha:repo.candidate,payload:prPayload({head:repo.candidate,base:repo.base}),workspace:repo.cwd});const normal=apiFixture(repo);
  for(const type of [undefined,'tag','tree'])await expectFallback(proveHistoryFastPath({env,root:repo.cwd,api:async(path)=>path.endsWith('/ref/heads/master')?{ref:'refs/heads/master',object:{sha:repo.base,type}}:normal(path)}),/ref binding/);
});
