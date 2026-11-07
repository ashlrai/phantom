import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createServer } from 'node:http';
import { configFrom, queueFrom, verdictFrom, screen, owned, green, Config, Job } from './policy.js';
import { Supervisor, initial, withinCap, stateFrom, Ports, once } from './supervisor.js';
import { cleanEnv, run, freshReview, sandboxProfile, dispatch } from './process.js';
import { GitHub, Snapshot } from './github.js';

const sha = 'a'.repeat(40), base = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
const repos = ['phantom', 'locus', 'lexicon', 'stack', 'phantom-secrets', 'cortex', 'ashlr'].map(r => `ashlrai/${r}`);
function config(): Config {
  return configFrom({ repos, pools: { codex: { executable: process.execPath, args: [] } },
    box: { executable: process.execPath, args: [] }, jobUser: 'rqjobs', gh: '/usr/local/bin/gh', supervisorHome: '/private/tmp/rq-owner',
    reviewer: { endpoint: 'http://127.0.0.1:11434/api/chat', model: 'review-fixture' }, dailyCap: 6, denylist: ['private/**'],
    requiredChecks: Object.fromEntries(repos.map(r => [r, ['CI']])), maxDiffBytes: 262144 });
}
const job: Job = { id: 'RQ1', repo: repos[0], pool: 'codex', prompt: 'Fix arithmetic. $(touch /tmp/should-not-exist) `env`' };
const queue = (jobs: unknown[]): string => '# Router\n```router-jobs\n' + JSON.stringify(jobs) + '\n```\n';
const patch = '@@ -1 +1 @@\n-old\n+new';
const diff = 'diff --git a/src/math.ts b/src/math.ts\nindex 1111111..2222222 100644\n--- a/src/math.ts\n+++ b/src/math.ts\n' + patch + '\n';
function snapshot(): Snapshot {
  return { pull: { number: 1, state: 'open', draft: false, merged: false, merge_commit_sha: null, merged_at: null, changed_files: 1,
    base: { sha: base, ref: 'master', repo: { full_name: repos[0], default_branch: 'master' } },
    head: { sha, repo: { full_name: 'masonwyatt23/phantom' } } },
    files: [{ filename: 'src/math.ts', patch, additions: 1, deletions: 1, status: 'modified' }], diff, codeowners: '' };
}
function harness() {
  const state = initial(); const events: Record<string, unknown>[] = []; const effects: string[] = [];
  let paused = false, authorized = true, moved = false, rejected = false, red = false, mainRed = false, merged = false, reverted = false;
  let now = 1800000000000; let reviews = 0; let snapshots = 0;
  const ports: Ports = {
    github: {
      pull: async () => ({ ...snapshot().pull, merged, merge_commit_sha: merged ? mergeSha : null, merged_at: merged ? new Date(now).toISOString() : null, head: { ...snapshot().pull.head, sha: moved ? 'd'.repeat(40) : sha } }),
      snapshot: async () => { snapshots++; const s = snapshot(); if (moved && snapshots > 1) s.pull.head.sha = 'd'.repeat(40); return s; },
      checks: async () => [{ name: 'CI', state: red ? 'failure' : 'success' }],
      main: async () => ({ sha: base, checks: [{ name: 'CI', state: mainRed ? 'failure' : 'success' }] }),
      reverted: async () => reverted,
      cancel: async () => { effects.push('cancel'); }, approve: async () => { effects.push('approve'); }, enable: async () => { effects.push('enable'); },
    },
    review: async () => { reviews++; return rejected ? { verdict: 'reject', reasons: ['security'] } : { verdict: 'approve', reasons: [] }; },
    dispatch: async (_j, repair) => { effects.push(repair ? 'repair' : 'dispatch'); return { pr: 1 }; },
    paused: async () => paused, authorized: async () => authorized, now: () => now,
    save: async () => { stateFrom(JSON.stringify(state), config()); }, audit: async e => { events.push(e); }, wake: async () => { effects.push('wake'); },
  };
  return { state, ports, events, effects, supervisor: new Supervisor(config(), 'Trusted hard rules', state, ports),
    set: (v: { paused?: boolean; authorized?: boolean; moved?: boolean; rejected?: boolean; red?: boolean; mainRed?: boolean; merged?: boolean; reverted?: boolean; now?: number }) => {
      paused = v.paused ?? paused; authorized = v.authorized ?? authorized; moved = v.moved ?? moved; rejected = v.rejected ?? rejected;
      red = v.red ?? red; mainRed = v.mainRed ?? mainRed; merged = v.merged ?? merged; reverted = v.reverted ?? reverted; now = v.now ?? now;
    }, reviews: () => reviews };
}

test('strict seven-repo configuration, caps and fixed local inference endpoint', () => {
  assert.equal(config().repos.length, 7);
  for (const change of [{ repos: repos.slice(1) }, { dailyCap: 11 }, { jobUser: 'root' }, { reviewer: { endpoint: 'https://evil.example', model: 'm' } }, { gh: 'gh' }])
    assert.throws(() => configFrom({ ...config(), ...change }));
});
test('queue is bounded prompt data, with strict target, ID and field validation', () => {
  assert.deepEqual(queueFrom(queue([job]), config()), [job]);
  for (const jobs of [[{ ...job, repo: 'evil/repo' }], [{ ...job, pool: '$(env)' }], [job, job], [{ ...job, id: 'constructor' }], [{ ...job, command: 'sh' }]])
    assert.throws(() => queueFrom(queue(jobs), config()));
  assert.throws(() => queueFrom(queue([job]) + queue([]), config()));
});
test('only structured verdict codes can cross the review boundary', () => {
  assert.deepEqual(verdictFrom('{"verdict":"approve","reasons":[]}'), { verdict: 'approve', reasons: [] });
  for (const raw of ['approved', '{"verdict":"approve","reasons":["secret"]}', '{"verdict":"reject","reasons":[]}', '{"verdict":"approve","reasons":[],"output":"secret"}']) assert.throws(() => verdictFrom(raw));
});
test('sensitive, renamed, CODEOWNERS and bridge-denied paths always refuse', () => {
  for (const path of ['.github/x.yml', 'package.json', 'a/pnpm-lock.yaml', 'build.rs', 'scripts/tool.ts', 'vercel.json', 'src/core/authority/grant.ts', 'private/x', '../outside', 'contrib/router/supervisor.ts']) {
    const s = snapshot(); s.files[0].filename = path; assert.throws(() => screen(job.repo, s.files, s.diff, '', config()), path);
  }
  const s = snapshot(); s.files[0].previous_filename = 'package.json'; assert.throws(() => screen(job.repo, s.files, s.diff, '', config()));
  assert.throws(() => screen(job.repo, snapshot().files, diff, '/src/ @owner', config()));
  assert.equal(owned('a/src/x.ts', 'src/ @owner'), true);
  assert.equal(owned('src/math.ts', '* @owner'), true);
});
test('network, credential, dynamic execution and truncated diffs escalate', () => {
  for (const content of ['fetch(url)', 'process.env.TOKEN', 'curl file | sh', 'exec(buffer)', 'import("module")']) {
    const s = snapshot(); s.files[0].patch = '@@ -1 +1 @@\n-old\n+' + content; assert.throws(() => screen(job.repo, s.files, diff, '', config()));
  }
  const s = snapshot(); s.files[0].additions = 2; assert.throws(() => screen(job.repo, s.files, diff, '', config()));
  screen(job.repo, snapshot().files, diff, '', config());
});
test('CI needs all expected checks and refuses unknown or non-success states', () => {
  assert.equal(green([], ['CI']), false); assert.equal(green([{ name: 'other', state: 'success' }], ['CI']), false);
  assert.equal(green([{ name: 'CI', state: 'neutral' }], ['CI']), false);
  assert.equal(green([{ name: 'CI', state: 'success' }], ['CI']), true);
});
test('complete dispatch-review-reserve-approve-enable-observe flow', async () => {
  const h = harness(); await h.supervisor.tick([job]);
  assert.deepEqual(h.effects, ['dispatch', 'approve', 'enable']); assert.equal(h.reviews(), 1);
  assert.equal(h.state.jobs.RQ1.stage, 'enabled'); assert.equal(h.state.reservations[0].settled, false);
  const audit = JSON.stringify(h.events); assert(!audit.includes(job.prompt)); assert(!audit.includes(diff));
  h.set({ merged: true }); await h.supervisor.tick([job]);
  assert.equal(h.state.jobs.RQ1.stage, 'done'); assert.equal(h.state.reservations[0].settled, true);
});
test('head movement during review forces a fresh review and never enables', async () => {
  const h = harness(); h.set({ moved: true }); await h.supervisor.tick([job]);
  assert(!h.effects.includes('approve')); assert(!h.effects.includes('enable')); assert.equal(h.state.jobs.RQ1.verdict, null);
  h.set({ moved: false }); await h.supervisor.tick([job]); assert.equal(h.reviews(), 2);
});
test('reject wakes only the exception box and never approves', async () => {
  const h = harness(); h.set({ rejected: true }); await h.supervisor.tick([job]);
  assert.deepEqual(h.effects, ['dispatch', 'wake']); assert.equal(h.state.jobs.RQ1.stage, 'exception');
});
test('PAUSE and revoked Security approval cancel before any fallible read', async () => {
  for (const flag of [{ paused: true }, { authorized: false }]) {
    const h = harness(); await h.supervisor.tick([job]); h.set(flag);
    h.ports.github.pull = async () => { throw new Error('API down'); };
    await h.supervisor.tick([]); assert.equal(h.effects.at(-1), 'cancel');
  }
});
test('pending PR is disabled and reviewed again after its head changes', async () => {
  const h = harness(); await h.supervisor.tick([job]); h.set({ moved: true }); await h.supervisor.tick([job]);
  assert(h.effects.includes('cancel')); assert.equal(h.effects.filter(e => e === 'enable').length, 1);
});
test('a merge racing PAUSE is still observed after cancellation', async () => {
  const h = harness(); await h.supervisor.tick([job]); h.set({ paused: true, merged: true });
  await h.supervisor.tick([job]); assert.equal(h.state.jobs.RQ1.stage, 'cancelled');
  h.set({ paused: false, mainRed: true }); await h.supervisor.tick([job]);
  assert.equal(h.state.jobs.RQ1.mergeSha, mergeSha); assert.equal(h.state.halt, 'main-red');
});
test('invalid queue cancels before unavailable public metadata reads', async () => {
  const h = harness(); await h.supervisor.tick([job]);
  h.ports.github.pull = async () => { throw new Error('rate limited'); };
  await h.supervisor.tick([], false, false); assert.equal(h.effects.at(-1), 'cancel');
  assert.equal(h.state.jobs.RQ1.stage, 'cancelled');
});
test('cancelled reservation settles at the actual observed merge time', async () => {
  const h = harness(); const start = h.ports.now(); await h.supervisor.tick([job]); h.set({ paused: true });
  await h.supervisor.tick([job]); h.set({ paused: false, merged: true, now: start + 7200000 });
  await h.supervisor.tick([job]); assert.equal(h.state.reservations[0].at, start + 7200000);
});
test('process recovery cancels reserved effects and latches unknown outcomes', async () => {
  const h = harness(); await h.supervisor.tick([job]); h.state.jobs.RQ1.stage = 'reserved';
  await h.supervisor.tick([job]); assert.equal(h.state.halt, 'unknown-outcome'); assert(h.effects.includes('cancel'));
  assert.equal(h.state.jobs.RQ1.stage, 'exception'); // Remote pull discharged the cancellation obligation.
});
test('PAUSE appearing during review blocks approval and merge', async () => {
  const h = harness(); h.ports.review = async () => { h.set({ paused: true }); return { verdict: 'approve', reasons: [] }; };
  await h.supervisor.tick([job]); assert(!h.effects.includes('approve')); assert(!h.effects.includes('enable'));
});
test('missing CI evidence holds without waking the exception box', async () => {
  const h = harness(); h.ports.github.checks = async () => [];
  await h.supervisor.tick([job]); assert.equal(h.reviews(), 0); assert(!h.effects.includes('wake')); assert(!h.effects.includes('enable'));
});
test('red CI gets one repair attempt, then escalates without weakening checks', async () => {
  const h = harness(); h.set({ red: true }); await h.supervisor.tick([job]);
  assert.equal(h.state.jobs.RQ1.stage, 'queued'); await h.supervisor.tick([job]);
  assert(h.effects.includes('repair')); assert.equal(h.state.jobs.RQ1.stage, 'exception'); assert(!h.effects.includes('enable'));
});
test('unknown dispatch outcome is latched and never replayed', async () => {
  const h = harness(); h.ports.dispatch = async () => { throw new Error('lost reply'); };
  await h.supervisor.tick([job]); assert.equal(h.state.halt, 'unknown-outcome');
  await h.supervisor.tick([job]); assert.equal(h.state.jobs.RQ1.attempts, 1);
});
test('two reverts or red main latch automation; acknowledged reverts stay cleared', async () => {
  const h = harness(); await h.supervisor.tick([job]); h.set({ merged: true, mainRed: true }); await h.supervisor.tick([job]);
  assert.equal(h.state.halt, 'main-red');
  h.state.halt = null; h.set({ mainRed: false, reverted: true }); h.state.reverted.push('e'.repeat(40));
  await h.supervisor.tick([job]); assert.equal(h.state.halt, 'two-reverts');
  h.state.halt = null; h.state.acknowledged.push(...h.state.reverted); h.state.reverted = [];
  await h.supervisor.tick([job]); assert.equal(h.state.halt, null);
});
test('quota counts actual merge times and old unresolved requests', () => {
  const s = initial(), now = 1800000000000;
  s.reservations = Array.from({ length: 3 }, (_, i) => ({ repo: job.repo, pr: i + 1, sha, at: now - 86400001, settled: false }));
  assert.equal(withinCap(s, job.repo, now, 6), false);
  for (const r of s.reservations) { r.settled = true; r.at = now; }
  assert.equal(withinCap(s, job.repo, now + 3599999, 6), false);
  assert.equal(withinCap(s, job.repo, now + 3600001, 6), true);
  assert.equal(withinCap(s, repos[1], now, 3), false);
});
test('corrupt state refuses rather than resetting the ledger', () => {
  assert.throws(() => stateFrom('{"version":1}', config()));
  const s = initial(); s.queue.RQ1 = 'untrusted raw prompt'; assert.throws(() => stateFrom(JSON.stringify(s), config()));
});
test('changed or removed queue entries cannot reuse approvals', async () => {
  const h = harness(); await h.supervisor.tick([job]); await h.supervisor.tick([{ ...job, prompt: 'changed' }]);
  assert(h.effects.includes('cancel')); assert.equal(h.state.jobs.RQ1.stage, 'cancelled');
  await h.supervisor.tick([{ ...job, prompt: 'changed' }]); assert.equal(h.state.jobs.RQ1.stage, 'exception');
  assert(h.events.some(e => e.type === 'queue-read' && JSON.stringify(e).includes('changed')));
});
test('credentials and ambient environment never reach child jobs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rq-env-test-'));
  const old = process.env.GH_TOKEN; process.env.GH_TOKEN = 'dummy-canary-never-a-real-token';
  try {
    const result = await run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({home:process.env.HOME,token:process.env.GH_TOKEN,nodeOptions:process.env.NODE_OPTIONS}))'], '', home);
    assert.deepEqual(JSON.parse(result), { home }); assert(!Object.hasOwn(cleanEnv(home), 'GH_TOKEN'));
  } finally { if (old === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = old; await rm(home, { recursive: true, force: true }); }
});
test('native mac sandbox blocks credential reads, runtime writes and loopback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rq-sandbox-test-')); const home = join(root, 'owner');
  await writeFile(home, 'dummy-private-canary'); await chmod(home, 0o600);
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const code = 'const fs=require("fs"),net=require("net");let blocked=false,writeBlocked=false;try{fs.readFileSync(process.argv[1])}catch{blocked=true}try{fs.writeFileSync(process.argv[2],"changed")}catch{writeBlocked=true}const socket=net.connect(Number(process.argv[3]),"127.0.0.1");socket.on("error",()=>process.stdout.write(JSON.stringify({blocked,writeBlocked,networkBlocked:true,token:process.env.GH_TOKEN})));socket.on("connect",()=>{process.stdout.write(JSON.stringify({blocked,writeBlocked,networkBlocked:false}));socket.destroy()});';
    const result = await run('/usr/bin/sandbox-exec', ['-p', sandboxProfile([home], root), process.execPath, '-e', code, home, join(root, 'write-probe'), String(address.port)], '', '/private/tmp');
    assert.deepEqual(JSON.parse(result), { blocked: true, writeBlocked: true, networkBlocked: true }); assert.equal(await readFile(home, 'utf8'), 'dummy-private-canary');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
test('dispatcher rejects sharing the supervisor OS account', async () => {
  const c = config(); c.jobUser = (await run('/usr/bin/id', ['-un'], '', '/private/tmp')).trim();
  await assert.rejects(dispatch(c, c.pools.codex, '{}', []), /separate-job-user/);
});
test('fresh no-tool reviewer protocol has no history, gh environment or scratch', async () => {
  let request: { tools?: unknown[]; messages?: unknown[]; keep_alive?: number } = {};
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c; request = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ done: true, message: { content: '{"verdict":"approve","reasons":[]}' } }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const c = config(); c.reviewer.endpoint = `http://127.0.0.1:${address.port}/api/chat`;
    assert.deepEqual(await freshReview(c, diff, 'trusted'), { verdict: 'approve', reasons: [] });
    assert.deepEqual(request.tools, []); assert.equal(request.messages?.length, 2); assert.equal(request.keep_alive, 0);
    assert(!JSON.stringify(request).includes('GH_TOKEN'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('GitHub uses immutable compare and paginates evidence', async () => {
  const gh = new GitHub(config()); const paths: string[] = [];
  gh.pull = async () => snapshot().pull;
  gh.read = async (path, accept) => {
    paths.push(path);
    if (path.includes('/compare/')) return accept?.includes('diff') ? diff : JSON.stringify({ files: snapshot().files });
    if (path.includes('/git/trees/')) return '{"truncated":false,"tree":[]}';
    throw new Error('unexpected path');
  };
  await gh.snapshot(job.repo, 1); assert(paths.some(p => p.includes(`${base}...${sha}`))); assert(!paths.some(p => p.includes('/pulls/')));
  gh.api = async <T>(path: string): Promise<T> => (path.includes('page=2') ? [] : Array(100).fill({ state: 'success' })) as T;
  assert.equal((await gh.pages('repos/ashlrai/phantom/statuses?per_page=100')).length, 100);
});
test('host API reads verify public allowlisted repos without broadening token scope', async () => {
  const gh = new GitHub(config()); const calls: string[][] = [];
  gh.command = async args => { calls.push(args); return args[1] === `repos/${job.repo}` ? '{"private":false}' : '{"check_runs":[]}'; };
  await gh.read(`repos/${job.repo}/commits/${sha}/check-runs`);
  assert.equal(calls.length, 2); assert(!calls.flat().some(x => /token|auth refresh|scope/.test(x)));
  await assert.rejects(gh.read('repos/ashlrai/unlisted/commits/x'));
});
test('first-run service remains inert without Security approval and never resets missing state', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rq-service-test-')));
  const control = join(root, 'control'), home = join(root, 'owner');
  await mkdir(control, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  const c = config(); c.supervisorHome = home;
  try {
    await writeFile(join(control, 'config.json'), JSON.stringify(c), { mode: 0o600 });
    await writeFile(join(control, 'ENGINEER-RULES.md'), 'Canonical operator policy fixture', { mode: 0o600 });
    await writeFile(join(control, 'INITIALIZE'), 'initialize\n', { mode: 0o600 });
    await writeFile(join(control, 'router-queue.md'), queue([job]), { mode: 0o600 });
    await once(control);
    const state = stateFrom(await readFile(join(control, 'fleet.json'), 'utf8'), c);
    assert.deepEqual(state.jobs, {}); assert.deepEqual(state.reservations, []);
    await rm(join(control, 'fleet.json'));
    await assert.rejects(once(control));
  } finally { await rm(root, { recursive: true, force: true }); }
});
