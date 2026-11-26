import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriveNodes, LocalNodesStore, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
import { probeLocalAuth } from '../src/core/drive/nodes/auth-probe.js';
import { emptyState, parseState } from '../src/core/drive/nodes/state.js';
import { localPhmVersion, versionCap } from '../src/core/drive/nodes/phm-version.js';
import { cmdNode } from '../src/cli/node.js';

class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.state = draft;
    return structuredClone(result);
  }
}

function fixture() {
  let now = 1_000;
  const store = new MemoryStore();
  const options = { now: () => now, nodeTtlMs: 100, leaderTtlMs: 20, claimTtlMs: 40 };
  // Separate instances over one store model separate processes on one host.
  const box = new DriveNodes(store, options);
  const mac = new DriveNodes(store, options);
  return { box, mac, store, advance: (ms: number) => { now += ms; } };
}

describe('node router', () => {
  it('routes by caps and live usage, deterministically, with the box as one more node', () => {
    const f = fixture();
    f.box.join('box-coordinator', { owners: ['acme'], caps: ['gh', 'build'] });
    f.mac.join('mac-1', { owners: ['acme'], caps: ['build'] });
    f.box.heartbeat({ nodeId: 'box-coordinator', session: 1 }, { usage: 800, auth: 'ok' });
    f.mac.heartbeat({ nodeId: 'mac-1', session: 2 }, { usage: 100 });
    f.box.enqueue('j-build', { owner: 'acme', requires: ['build'] });
    f.box.enqueue('j-gh', { owner: 'acme', requires: ['gh'] });
    f.box.enqueue('j-gpu', { owner: 'acme', requires: ['gpu'] });
    const plan = f.box.plan();
    expect(plan.map(r => [r.jobId, r.nodeId])).toEqual([['j-build', 'mac-1'], ['j-gh', 'box-coordinator'], ['j-gpu', null]]);
    expect(plan[2]!.fix).toContain('--caps');
    expect(f.mac.plan()).toEqual(plan); // same state, same answer
  });

  it('spreads equal-load jobs instead of piling on one node', () => {
    const f = fixture();
    f.box.join('a', { owners: ['o'] });
    f.mac.join('b', { owners: ['o'] });
    for (const id of ['j1', 'j2', 'j3', 'j4']) f.box.enqueue(id, { owner: 'o' });
    const nodes = f.box.plan().map(r => r.nodeId);
    expect(nodes).toEqual(['a', 'b', 'a', 'b']);
  });

  it('accounts for shared slots before filtering the routing preview by owner', () => {
    const f = fixture();
    const shared = f.box.join('shared', { owners: ['A', 'B'], slots: 1 })!;
    f.box.enqueue('first', { owner: 'A' });
    f.box.enqueue('second', { owner: 'B' });

    expect(f.box.plan('B')).toEqual([
      { jobId: 'second', owner: 'B', nodeId: null, fix: expect.stringContaining('no free job slots') },
    ]);
    expect(f.box.plan('B')).toEqual(f.box.view(['B']).routes);
    const first = f.box.pull(shared)!;
    expect(first.job.id).toBe('first');
    expect(f.box.complete(first.claim, 'done')).toBe(true);

    expect(f.box.plan('B')).toEqual([{ jobId: 'second', owner: 'B', nodeId: 'shared' }]);
    expect(f.box.pull(shared)?.job.id).toBe('second');
  });

  it('requires a live local gh-auth heartbeat for gh jobs and explains the fix', () => {
    const f = fixture();
    const s = f.box.join('n', { owners: ['o'], caps: ['gh'] })!;
    f.box.enqueue('j', { owner: 'o', requires: ['gh'] });
    expect(f.box.plan()[0]).toMatchObject({ nodeId: null, fix: expect.stringContaining('gh auth login') });
    f.box.heartbeat(s, { auth: 'missing' });
    expect(f.box.plan()[0]!.nodeId).toBeNull();
    f.box.heartbeat(s, { auth: 'ok' });
    expect(f.box.plan()[0]!.nodeId).toBe('n');
  });

  it('skips expired nodes and tells the operator how to add one', () => {
    const f = fixture();
    f.box.join('n', { owners: ['o'] });
    f.box.enqueue('j', { owner: 'o' });
    f.advance(100);
    expect(f.box.plan()[0]).toMatchObject({ nodeId: null, fix: expect.stringContaining('phm node join') });
  });

  it('the no-node fix prints the shortest runnable join, naming the caps the job needs', () => {
    const f = fixture();
    f.box.enqueue('j-caps', { owner: 'o', requires: ['build', 'gh'] });
    f.box.enqueue('j-plain', { owner: 'o' });
    const plan = f.box.plan();
    expect(plan.find(r => r.jobId === 'j-caps')).toMatchObject({ nodeId: null,
      fix: "No live node belongs to owner 'o'. Run: phm node join --owner o --caps build,gh" });
    expect(plan.find(r => r.jobId === 'j-plain')).toMatchObject({ nodeId: null,
      fix: "No live node belongs to owner 'o'. Run: phm node join --owner o" });
  });
});

describe('job leases: no job runs twice', () => {
  it('two nodes racing the same job get exactly one claim', () => {
    const f = fixture();
    const a = f.box.join('a', { owners: ['o'] })!;
    const b = f.mac.join('b', { owners: ['o'] })!;
    f.box.enqueue('only', { owner: 'o' });
    // Make both nodes equally entitled: whichever the router prefers, the other pulls nothing.
    const results = [f.box.pull(a), f.mac.pull(b)];
    expect(results.filter(Boolean)).toHaveLength(1);
    // Even forced through the plain claim path the loser is refused.
    const leader = f.box.heartbeat(a)!.leader!;
    expect(f.box.claim(leader, a, 'only')).toBeNull();
  });

  it('expiry hands the job to the other node with a higher fencing token; the stale holder is fenced', () => {
    const f = fixture();
    const a = f.box.join('a', { owners: ['o'] })!;
    const b = f.mac.join('b', { owners: ['o'] })!;
    f.box.enqueue('job', { owner: 'o' });
    const first = f.box.pull(a)!;
    expect(first).not.toBeNull();
    expect(f.mac.pull(b)).toBeNull(); // lease live: nobody else may take it
    f.advance(40); // lease lapses
    f.mac.heartbeat(b); f.box.heartbeat(a);
    f.advance(1);
    f.mac.heartbeat(b); f.box.heartbeat(a);
    const second = f.mac.pull(b) ?? f.box.pull(a)!;
    expect(second.claim.token).toBeGreaterThan(first.claim.token);
    expect(f.box.complete(first.claim, 'late')).toBe(false); // old holder cannot commit
    expect(f.box.renewClaim(first.claim)).toBeNull();
    expect(f.mac.complete(second.claim, 'ok')).toBe(true);
    expect(f.mac.complete(second.claim, 'ok')).toBe(false);
    expect(f.box.pull(a)).toBeNull(); // completed jobs never run again
    expect(f.mac.pull(b)).toBeNull();
  });

  it('works across real store instances sharing a directory', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-router-')));
    try {
      const priv = join(dir, 'n');
      mkdirSync(priv, { mode: 0o700 });
      const x = new DriveNodes(new LocalNodesStore(priv));
      const y = new DriveNodes(new LocalNodesStore(priv));
      const sx = x.join('x', { owners: ['o'] })!;
      const sy = y.join('y', { owners: ['o'] })!;
      x.enqueue('race', { owner: 'o' });
      expect([x.pull(sx), y.pull(sy)].filter(Boolean)).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('owner scope isolation', () => {
  function two() {
    const f = fixture();
    const a = f.box.join('node-a', { owners: ['A'], caps: ['gh'] })!;
    const b = f.mac.join('node-b', { owners: ['B'], caps: ['gh'] })!;
    f.box.heartbeat(a, { auth: 'ok' }); f.mac.heartbeat(b, { auth: 'ok' });
    f.box.enqueue('job-a', { owner: 'A', pack: 'pack-a', secrets: ['A_API_KEY'] });
    f.box.enqueue('job-b', { owner: 'B', pack: 'pack-b', secrets: ['B_API_KEY'], requires: ['gh'] });
    return { ...f, a, b };
  }

  it('a node owned by A never sees B\'s jobs, packs, secrets or nodes', () => {
    const f = two();
    const view = JSON.stringify(f.box.view(['A']));
    for (const leak of ['job-b', 'pack-b', 'B_API_KEY', 'node-b']) expect(view).not.toContain(leak);
    expect(view).toContain('job-a');
    expect(view).toContain('pack-a');
    const pulled = JSON.stringify(f.box.pull(f.a));
    for (const leak of ['job-b', 'pack-b', 'B_API_KEY']) expect(pulled).not.toContain(leak);
    expect(f.box.plan('A').map(r => r.jobId)).toEqual([]); // job-a already claimed above
    expect(JSON.stringify(f.mac.view(['B']))).not.toContain('pack-a');
    expect(JSON.stringify(f.mac.view(['B']))).not.toContain('A_API_KEY');
  });

  it('A cannot pull B\'s job even when B has no live node', () => {
    const f = two();
    f.mac.leave(f.b);
    expect(f.box.pull(f.a)!.job.id).toBe('job-a');
    expect(f.box.pull(f.a)).toBeNull();
    expect(f.box.snapshot().jobs.find(j => j.id === 'job-b')!.state).toBe('pending');
    expect(f.box.plan()[0]!.fix).toContain("owner 'B'");
  });

  it('never routes a job that has no owner scope', () => {
    const f = fixture();
    const s = f.box.join('n', { owners: ['o'] })!;
    f.box.enqueue('legacy');
    expect(f.box.plan()).toEqual([]);
    expect(f.box.pull(s)).toBeNull();
  });

  it('rejects secret values and malformed scopes at the door', () => {
    const f = fixture();
    expect(() => f.box.enqueue('j', { owner: 'o', secrets: ['sk-live-abc123'] })).toThrow(/secret name/);
    expect(() => f.box.enqueue('j', { owner: 'bad owner' })).toThrow(/owner/);
    expect(() => f.box.join('n', { owners: [] })).toThrow(/owner/);
    expect(() => f.box.join('n', { owners: ['o'], caps: ['Has Space'] })).toThrow(/capability/);
    expect(() => parseState({ ...emptyState(), jobs: [{ id: 'j', state: 'pending', secrets: ['sk-live-1'] }] })).toThrow();
  });
});

describe('phm node CLI', () => {
  let dir: string;
  afterEach(() => { vi.restoreAllMocks(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  async function cli(...args: string[]) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await cmdNode(args);
    const out = log.mock.calls.map(c => String(c[0])).join('\n');
    const err = error.mock.calls.map(c => String(c[0])).join('\n');
    log.mockRestore(); error.mockRestore();
    return { code, out, err };
  }

  it('runs the documented copy-paste flow end to end with --json', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-cli-')));
    vi.stubEnv('ASHLR_HOME', dir);
    const joined = JSON.parse((await cli('join', '--node', 'box', '--owner', 'acme', '--caps', 'build', '--json')).out);
    expect(joined).toMatchObject({ schemaVersion: 1, command: 'join', nodeId: 'box', owners: ['acme'] });
    // A standalone join also advertises this build as a phm-<version> cap.
    expect(joined.caps).toEqual(['build', versionCap(localPhmVersion())!]);
    const s = String(joined.session);
    expect((await cli('enqueue', '--job', 'j1', '--owner', 'acme', '--requires', 'build', '--pack', 'pack-1', '--secrets', 'DEPLOY_KEY', '--json')).code).toBe(0);
    expect(JSON.parse((await cli('plan', '--json')).out).routes).toEqual([{ jobId: 'j1', owner: 'acme', nodeId: 'box' }]);
    const pulled = JSON.parse((await cli('pull', '--node', 'box', '--session', s, '--json')).out);
    expect(pulled.job).toMatchObject({ id: 'j1', pack: 'pack-1', secrets: ['DEPLOY_KEY'] });
    const lease = ['--job', 'j1', '--node', 'box', '--session', s, '--token', String(pulled.claim.token), '--leader-token', String(pulled.claim.leaderToken)];
    expect((await cli('renew', ...lease, '--json')).code).toBe(0);
    expect((await cli('complete', ...lease, '--result', 'done', '--json')).code).toBe(0);
    const again = await cli('complete', ...lease, '--json');
    expect(again.code).toBe(1);
    expect(JSON.parse(again.out).error).toMatchObject({ code: 'lease-lost', fix: expect.any(String) });
    const status = await cli('status', '--owner', 'other', '--json');
    expect(JSON.parse(status.out)).toMatchObject({ nodes: [], jobs: [], routes: [] });
    expect(status.out).not.toContain('j1');
  });

  it('join prints its keep-alive beat and session refusals name the live session', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-cli-')));
    vi.stubEnv('ASHLR_HOME', dir);
    const joined = JSON.parse((await cli('join', '--node', 'laptop', '--owner', 'acme', '--json')).out);
    // next is the --watch keep-alive: a one-shot beat would expire 30 s later.
    expect(joined.next).toBe(`phm node beat --node laptop --session ${joined.session} --watch`);
    const text = await cli('join', '--node', 'desktop', '--owner', 'acme');
    // Text mode answers in plain words: the join fact, the 30 s session expiry
    // and the keep-alive command — not the key:value dump --json uses.
    expect(text.out).toContain('Joined desktop as session ');
    expect(text.out).toContain('for owner acme');
    expect(text.out).toContain('expires 30 seconds after the last beat');
    expect(text.out).toContain('phm node beat --node desktop --session ');
    const again = await cli('join', '--node', 'laptop', '--owner', 'acme', '--json');
    expect(again.code).toBe(1);
    expect(JSON.parse(again.out).error).toMatchObject({ code: 'node-live',
      fix: expect.stringContaining(`phm node leave --node laptop --session ${joined.session}`) });
    const stale = await cli('beat', '--node', 'laptop', '--session', '999', '--json');
    expect(stale.code).toBe(1);
    const error = JSON.parse(stale.out).error;
    expect(error.code).toBe('session-expired');
    expect(error.fix).toContain(`live as session ${joined.session}`);
    const left = await cli('leave', '--node', 'laptop', '--session', '999', '--json');
    expect(left.code).toBe(0);
    expect(JSON.parse(left.out)).toMatchObject({ left: false, liveSession: joined.session,
      next: `phm node leave --node laptop --session ${joined.session}` });
  });

  it('join next probes gh auth only when the node advertised the gh cap', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-cli-')));
    vi.stubEnv('ASHLR_HOME', dir);
    // Routing refuses gh jobs until a heartbeat reports auth ok, so a node that
    // advertised gh gets --probe-auth in its keep-alive; other caps do not.
    const gh = JSON.parse((await cli('join', '--node', 'ghbox', '--owner', 'acme', '--caps', 'build,gh', '--json')).out);
    expect(gh.next).toBe(`phm node beat --node ghbox --session ${gh.session} --probe-auth --watch`);
    const build = JSON.parse((await cli('join', '--node', 'buildbox', '--owner', 'acme', '--caps', 'build', '--json')).out);
    expect(build.next).toBe(`phm node beat --node buildbox --session ${build.session} --watch`);
    expect(build.next).not.toContain('--probe-auth');
  });

  it('join names the local registry boundary in JSON and text', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-cli-')));
    vi.stubEnv('ASHLR_HOME', dir);
    // A standalone join reaches only this machine's private store, so the
    // reply itself must say so — an outside contributor's first command is
    // where the "I joined the fleet" misunderstanding starts.
    const joined = JSON.parse((await cli('join', '--node', 'laptop', '--owner', 'acme', '--json')).out);
    expect(joined.registry).toBe('local');
    const text = await cli('join', '--node', 'desktop', '--owner', 'acme');
    expect(text.out).toContain('local to this machine');
    expect(text.out).toContain('docs/NODES.md');
    // The beat keep-alive hint is unchanged; the boundary line follows it.
    expect(text.out.indexOf('phm node beat --node desktop')).toBeLessThan(text.out.indexOf('local to this machine'));
  });

  it('reports unmeasured load as unknown, never a fabricated 0', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-cli-')));
    vi.stubEnv('ASHLR_HOME', dir);
    const joined = JSON.parse((await cli('join', '--node', 'laptop', '--owner', 'acme', '--json')).out);
    const s = String(joined.session);
    const before = JSON.parse((await cli('status', '--owner', 'acme', '--json')).out);
    expect(before.nodes).toEqual([expect.objectContaining({ nodeId: 'laptop', usage: null })]);
    // Text mode renders the node view, not the plan's routes array.
    expect((await cli('status', '--owner', 'acme')).out).toContain('node laptop live usage=unknown');
    expect((await cli('list', '--owner', 'acme')).out).toContain('node laptop live usage=unknown');
    expect((await cli('plan', '--owner', 'acme')).out).toBe('No routable jobs.');
    expect((await cli('beat', '--node', 'laptop', '--session', s, '--usage', '250', '--json')).code).toBe(0);
    const after = JSON.parse((await cli('status', '--owner', 'acme', '--json')).out);
    expect(after.nodes[0].usage).toBe(250);
    // A beat without --usage keeps the last reported value rather than resetting it.
    expect((await cli('beat', '--node', 'laptop', '--session', s, '--json')).code).toBe(0);
    expect(JSON.parse((await cli('status', '--owner', 'acme', '--json')).out).nodes[0].usage).toBe(250);
  });

  it('runs the documented flow through a symlinked ASHLR_HOME (scratch homes under macOS $TMPDIR)', async () => {
    // /var -> /private/var on macOS makes every mkdtemp home "symlinked"; the
    // store must canonicalize before its private-directory checks.
    if (process.platform === 'win32') return;
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'node-cli-real-')));
    const link = join(realpathSync(tmpdir()), `node-cli-link-${process.pid}-${Date.now()}`);
    symlinkSync(real, link, 'dir');
    dir = real;
    vi.stubEnv('ASHLR_HOME', join(link, '.ashlr'));
    try {
      const joined = JSON.parse((await cli('join', '--node', 'scratch', '--owner', 'acme', '--caps', 'build', '--json')).out);
      expect(joined).toMatchObject({ schemaVersion: 1, command: 'join', nodeId: 'scratch', owners: ['acme'] });
      expect(joined.caps).toEqual(['build', versionCap(localPhmVersion())!]);
      const s = String(joined.session);
      expect((await cli('beat', '--node', 'scratch', '--session', s, '--json')).code).toBe(0);
      const status = JSON.parse((await cli('status', '--owner', 'acme', '--json')).out);
      expect(status.nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual(['scratch']);
      expect(JSON.parse((await cli('leave', '--node', 'scratch', '--session', s, '--json')).out)).toMatchObject({ left: true });
    } finally { rmSync(link, { recursive: true, force: true }); }
  });

  it('surfaces the real store error instead of a generic store failure', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-cli-err-')));
    mkdirSync(join(dir, '.ashlr'), { recursive: true });
    writeFileSync(join(dir, '.ashlr', 'nodes'), 'not a directory');
    vi.stubEnv('ASHLR_HOME', join(dir, '.ashlr'));
    const res = await cli('join', '--node', 'x', '--owner', 'o', '--json');
    expect(res.code).toBe(1);
    expect(JSON.parse(res.out).error).toMatchObject({ code: 'rejected', message: expect.stringContaining('private directory') });
  });

  it('errors say how to fix themselves and never echo argument values', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-cli-')));
    vi.stubEnv('ASHLR_HOME', dir);
    const missing = await cli('join', '--node', 'x');
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('--owner is required');
    expect(missing.err).toContain('Fix:');
    const secret = await cli('enqueue', '--job', 'j', '--owner', 'o', '--secrets', 'sk-live-supersecret');
    expect(secret.code).toBe(2);
    expect(secret.err).not.toContain('supersecret');
    expect(secret.err).toContain('NAME');
    const secretJson = await cli('enqueue', '--job', 'j', '--owner', 'o', '--secrets', 'sk-live-supersecret', '--json');
    expect(JSON.parse(secretJson.out).error).toMatchObject({ code: 'bad-secrets' });
    expect(secretJson.out).not.toContain('supersecret');
    const bad = await cli('join', '--node', 'x', '--owner', 'o', '--token=supersecret');
    expect(bad.code).toBe(2);
    expect(bad.err).not.toContain('supersecret');
    const stale = await cli('beat', '--node', 'ghost', '--session', '9', '--json');
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.out).error.fix).toContain('phm node join');
  });

  it('reports flag parse errors through the documented JSON error envelope with --json', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-cli-')));
    vi.stubEnv('ASHLR_HOME', dir);
    const cases: [string[], string][] = [
      [['join', '--node', 'x', '--owner', 'o', '--bogus', '--json'], 'unknown-flag'],
      [['join', '--node', 'x', '--owner', 'o', '--caps', '--json'], 'missing-value'],
      [['join', '--node', 'a', '--node', 'b', '--owner', 'o', '--json'], 'duplicate-flag'],
      [['plan', '--owner', '--json'], 'missing-value'],
    ];
    for (const [args, code] of cases) {
      const res = await cli(...args);
      expect(res.code).toBe(2);
      expect(res.err).toBe('');
      expect(JSON.parse(res.out)).toMatchObject({ schemaVersion: 1, command: args[0],
        error: { code, message: expect.any(String), fix: expect.any(String) } });
    }
    // Without --json the same failures stay human text on stderr.
    const text = await cli('join', '--node', 'x', '--owner', 'o', '--bogus');
    expect(text.code).toBe(2);
    expect(text.out).toBe('');
    expect(text.err).toContain('That flag is not supported');
    // A rejected flag's value is never echoed into the JSON error either.
    const secret = await cli('join', '--node', 'x', '--owner', 'o', '--token=supersecret', '--json');
    expect(secret.code).toBe(2);
    expect(secret.out).not.toContain('supersecret');
    expect(JSON.parse(secret.out).error.code).toBe('unknown-flag');
  });

  it('reports out-of-range measured flags as usage errors, not store failures', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-cli-')));
    vi.stubEnv('ASHLR_HOME', dir);
    const joined = JSON.parse((await cli('join', '--node', 'laptop', '--owner', 'acme', '--json')).out);
    const s = String(joined.session);
    // The store bounds --usage at 0-1000 permille and --slots at 0-64; a value
    // past them is bad usage (exit 2, code naming the flag), never the masked
    // "Invalid drive ..." store error with the ids/caps fix.
    const cases: [string[], string, string][] = [
      [['beat', '--node', 'laptop', '--session', s, '--usage', '1001', '--json'], 'bad-usage', '--usage must be an integer from 0 to 1000.'],
      [['beat', '--node', 'laptop', '--session', s, '--slots', '65', '--json'], 'bad-slots', '--slots must be an integer from 0 to 64.'],
      [['join', '--node', 'other', '--owner', 'acme', '--slots', '65', '--json'], 'bad-slots', '--slots must be an integer from 0 to 64.'],
    ];
    for (const [args, code, message] of cases) {
      const res = await cli(...args);
      expect(res.code).toBe(2);
      expect(res.err).toBe('');
      expect(JSON.parse(res.out)).toMatchObject({ schemaVersion: 1, command: args[0],
        error: { code, message, fix: expect.stringContaining('phm node --help') } });
    }
    // The documented ceilings themselves still pass, and text mode keeps the
    // same usage classification on stderr.
    expect((await cli('beat', '--node', 'laptop', '--session', s, '--usage', '1000', '--slots', '64', '--json')).code).toBe(0);
    expect((await cli('join', '--node', 'edge', '--owner', 'acme', '--slots', '0', '--json')).code).toBe(0);
    const text = await cli('beat', '--node', 'laptop', '--session', s, '--usage', '1001');
    expect(text.code).toBe(2);
    expect(text.out).toBe('');
    expect(text.err).toContain('--usage must be an integer from 0 to 1000.');
  });

  it('sends bare and --json-only join to the standalone registry error, not the pool', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'node-cli-')));
    vi.stubEnv('ASHLR_HOME', dir);
    // No pool config exists here: argument-free join must reach the standalone
    // parser's missing-flag error, never the multi-Mac pool's SSH-alias error.
    const bare = await cli('join');
    expect(bare.code).toBe(2);
    expect(bare.err).toContain('--owner is required');
    expect(bare.err).not.toContain('--primary');
    const json = await cli('join', '--json');
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out).error).toMatchObject({ code: 'missing-flag' });
  });

  it('reports usage for bare and unknown node verbs instead of the bootstrap error', async () => {
    const bare = await cli();
    expect(bare.code).toBe(2);
    expect(bare.err).toContain('phm node --help');
    expect(bare.err).not.toContain('bootstrap');
    const bogus = await cli('frobnicate');
    expect(bogus.code).toBe(2);
    expect(bogus.err).toContain("Unknown node command 'frobnicate'");
  });

  it('keeps bootstrap and help working', async () => {
    expect((await cli('--help')).out).toContain('Usage: phm node bootstrap --dry-run');
    expect((await cli('--help')).out).toContain('phm node pull');
  });
});

describe('local auth probe', () => {
  it('reads only the exit status and never captures output', () => {
    const run = vi.fn().mockReturnValue({ status: 0, error: undefined });
    expect(probeLocalAuth(run as never)).toBe('ok');
    expect(run).toHaveBeenCalledWith('gh', ['auth', 'status'], expect.objectContaining({ stdio: 'ignore' }));
    expect(probeLocalAuth((() => ({ status: 1 })) as never)).toBe('missing');
    expect(probeLocalAuth((() => ({ error: new Error('ENOENT') })) as never)).toBe('unknown');
  });
});
