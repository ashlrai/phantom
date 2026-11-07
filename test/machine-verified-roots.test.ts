import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, chmodSync, linkSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProtectedAttemptWitness, readVerifiedFleetRoots, createMachineRootDependencies, type MachineRootDependencies, type MachineRootIo } from '../src/core/resources/machine-verified-roots.js';
import { parseQueueStatus } from '../src/core/resources/telemetry-parsers.js';

// Virtual history exercises the complete real reader scan without creating
// forty thousand filesystem entries in an ordinary unit-test lifecycle.
const virtualNamespaces = vi.hoisted(() => new Map<string, { names: string[]; reads: number; closes: number }>());
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, opendirSync: (path: string, options?: unknown) => {
    const namespace = virtualNamespaces.get(String(path));
    if (!namespace) return actual.opendirSync(path, options as Parameters<typeof actual.opendirSync>[1]);
    let offset = 0;
    return { readSync: () => { namespace.reads++; return offset < namespace.names.length ? { name: namespace.names[offset++]! } : null; }, closeSync: () => { namespace.closes++; } };
  } };
});

const now = Date.parse('2026-11-06T21:00:00.000Z');
const root = { jobId: 'RQ-TEST', pid: 101, repo: 'phantom', lane: 'codex-cmp', tier: 'work', ageSeconds: 2 };
const worker = { ...root, job: root.jobId };
const snapshot = (workers = [worker]) => ({ v: 1, generatedAt: new Date(now).toISOString(), sourceState: 'healthy', workers, leaders: [], orchestratorAgents: 0 });
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'test-roots-'))), runsDir = join(dir, 'R'), worktreeRoot = join(dir, 'WT'), run = join(runsDir, 'queue', 'run');
  mkdirSync(run, { recursive: true, mode: 0o755 }); mkdirSync(join(runsDir, 'queue', 'prompts'), { mode: 0o755 }); mkdirSync(worktreeRoot, { mode: 0o755 });
  const status = (count = 1) => writeFileSync(join(runsDir, 'queue', 'status.json'), JSON.stringify({ schema: 'dispatchd.status.v1', last_tick: new Date(now).toISOString(), paused: null, lanes: { 'codex-cmp': { running: count } } }), { mode: 0o600 });
  const add = (job = root.jobId, prompt = `${job}.md`) => {
    mkdirSync(join(worktreeRoot, job), { mode: 0o755 });
    writeFileSync(join(runsDir, 'queue', 'prompts', prompt), 'PRIVATE PROMPT MUST NOT BE READ', { mode: 0o600 });
    writeFileSync(join(run, `${job}.line`), `${job}\tphantom\tcodex-cmp\twork\t${runsDir}/queue/prompts/${prompt}\tpin\n`, { mode: 0o600 });
    writeFileSync(join(run, `${job}.dispatched`), '1794000000\n', { mode: 0o600 });
    writeFileSync(join(runsDir, `${job}.base`), `1111111111111111111111111111111111111111 codex-bridge/${job} ${worktreeRoot}/${job} codex-cmp\n`, { mode: 0o600 });
  };
  add(); status();
  const options = { runsDir, worktreeRoot, now: () => now };
  const deps: MachineRootDependencies = { now: () => now, uid: 501, inspectTargetedWorkers: async () => snapshot(), readProtectedAttempt: async job => readProtectedAttemptWitness(options, job), readStart: async () => ({ source: 'ps-lstart', ref: 'a'.repeat(64) }), readBoot: async () => 'b'.repeat(64), readUid: async () => 501 };
  return { dir, run, add, status, options, deps, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
afterEach(() => { vi.useRealTimers(); virtualNamespaces.clear(); });
describe('verified root observations', () => {
  it('binds protected synthetic metadata and emits no private paths', async () => {
    const f = fixture(); try { const result = await readVerifiedFleetRoots(f.options, f.deps); expect(result.state).toBe('known'); expect(result.roots).toHaveLength(1); expect(JSON.stringify(result)).not.toContain(f.dir); expect(JSON.stringify(result)).not.toContain('PRIVATE'); } finally { f.cleanup(); }
  });
  it('permits a healthy inspected empty set', async () => { const f = fixture(); try { rmSync(join(f.run, `${root.jobId}.dispatched`)); f.status(0); f.deps.inspectTargetedWorkers = async () => snapshot([]); expect((await readVerifiedFleetRoots(f.options, f.deps)).state).toBe('known'); } finally { f.cleanup(); } });
  it.each(['start', 'boot', 'uid', 'owner', 'duplicate', 'failure', 'stale'])('fails closed for %s', async kind => {
    const f = fixture(); try {
      let n = 0;
      if (kind === 'start') f.deps.readStart = async () => ({ source: 'ps-lstart', ref: (++n === 1 ? 'a' : 'c').repeat(64) });
      if (kind === 'boot') f.deps.readBoot = async () => (++n === 1 ? 'b' : 'c').repeat(64);
      if (kind === 'uid') f.deps.readUid = async () => 502;
      if (kind === 'owner') f.deps.readProtectedAttempt = async () => undefined;
      if (kind === 'duplicate') f.deps.inspectTargetedWorkers = async () => snapshot([worker, worker]);
      if (kind === 'failure') f.deps.inspectTargetedWorkers = async () => { throw new Error('private'); };
      if (kind === 'stale') f.deps.inspectTargetedWorkers = async () => ({ ...snapshot(), generatedAt: new Date(now + 60000).toISOString() });
      const result = await readVerifiedFleetRoots(f.options, f.deps); expect(result.state).toBe('unknown'); expect(result.roots).toEqual([]);
    } finally { f.cleanup(); }
  });
  it('rejects symlinked metadata', () => { const f = fixture(); try { const path = join(f.options.runsDir, `${root.jobId}.base`); rmSync(path); symlinkSync('/dev/null', path); expect(readProtectedAttemptWitness(f.options, root.jobId)).toBeUndefined(); } finally { f.cleanup(); } });
  it('distinguishes current aggregate pause from arbitrary null', () => {
    expect(parseQueueStatus('{"schema":"dispatchd.status.v1","paused":null,"running":2}')).toEqual({ pids: [], paused: false });
    expect(parseQueueStatus('{"paused":null,"running":2}')).toEqual({ pids: [], paused: null });
    expect(parseQueueStatus('{"schema":"dispatchd.status.v1"}').paused).toBeNull();
  });
  it('verifies two independent roots and accepts ordinary alternate prompt basenames', async () => {
    const f = fixture(); try {
      f.add('RQ-TWO', 'existing-operator-prompt.md'); f.status(2);
      f.deps.inspectTargetedWorkers = async () => snapshot([worker, { ...worker, job: 'RQ-TWO', pid: 202 }]);
      const r = await readVerifiedFleetRoots(f.options, f.deps); expect(r.state).toBe('known'); expect(r.roots.map(x => x.pid)).toEqual([101, 202]);
    } finally { f.cleanup(); }
  });
  it.each(['retained-history', 'late-invalid-current-marker', 'enumeration-budget'] as const)('completely bounds the real 40,018-entry history namespace: %s', async kind => {
    const f = fixture(); try {
      const namespace = { names: Array.from({ length: kind === 'enumeration-budget' ? 65536 : 40016 }, (_, i) => `RQ-OLD-${i}.rc`), reads: 0, closes: 0 };
      // A valid current marker appears after every retained historical record.
      namespace.names.push(`${root.jobId}.line`, `${root.jobId}.dispatched`);
      if (kind === 'late-invalid-current-marker') namespace.names.push('bad!.dispatched');
      virtualNamespaces.set(f.run, namespace);
      const result = await readVerifiedFleetRoots(f.options, f.deps);
      expect(result.state).toBe(kind === 'retained-history' ? 'known' : 'unknown');
      if (kind === 'retained-history') { expect(result.roots).toHaveLength(1); expect(namespace.reads).toBe(2 * (40018 + 1)); expect(namespace.closes).toBe(2); }
      else { expect(result.roots).toEqual([]); expect(namespace.closes).toBe(1); }
    } finally { f.cleanup(); }
  });
  it.each(['.', '..'])('refuses a dot-component job rather than normalizing its worktree outside the owned namespace: %s', job => {
    const f = fixture(); try { expect(readProtectedAttemptWitness(f.options, job)).toBeUndefined(); } finally { f.cleanup(); }
  });
  it('does not turn aggregate counts or pending dispatches into verified absence', async () => {
    const f = fixture(); try { f.deps.inspectTargetedWorkers = async () => snapshot([]); expect((await readVerifiedFleetRoots(f.options, f.deps)).state).toBe('unknown'); f.status(0); expect((await readVerifiedFleetRoots(f.options, f.deps)).state).toBe('unknown'); } finally { f.cleanup(); }
  });
  it.each(['base-ref', 'base-branch', 'job', 'lane', 'tier', 'outside-prompt', 'outside-worktree', 'owner-job', 'owner-type', 'missing-owner', 'symlink-owner-dir', 'hardlink', 'writable-file', 'writable-parent', 'symlink-parent', 'worktree-symlink'])('refuses exact protected ownership mismatch: %s', kind => {
    const f = fixture(); try {
      const base = join(f.options.runsDir, `${root.jobId}.base`), line = join(f.run, `${root.jobId}.line`), prompt = join(f.options.runsDir, 'queue', 'prompts', `${root.jobId}.md`);
      if (kind.startsWith('base-')) writeFileSync(base, readFileSync(base, 'utf8').replace(kind === 'base-ref' ? '1'.repeat(40) : `codex-bridge/${root.jobId}`, kind === 'base-ref' ? 'bad' : 'wrong-branch'));
      if (['job','lane','tier'].includes(kind)) { const a = readFileSync(line, 'utf8').split('\t'); a[kind === 'job' ? 0 : kind === 'lane' ? 2 : 3] = 'invalid!'; writeFileSync(line, a.join('\t')); }
      if (kind === 'outside-prompt') writeFileSync(line, readFileSync(line, 'utf8').replace(prompt, join(f.dir, 'private.md')));
      if (kind === 'outside-worktree') writeFileSync(base, readFileSync(base, 'utf8').replace(f.options.worktreeRoot, f.dir));
      if (kind.startsWith('owner-')) { const d = join(f.run, `${root.jobId}.root-owner`); mkdirSync(d); writeFileSync(join(d, 'owner.json'), JSON.stringify(kind === 'owner-job' ? { owner: '/root/test', job: 'OTHER' } : { owner: ['/root/test'] }), { mode: 0o600 }); }
      if (kind === 'missing-owner') mkdirSync(join(f.run, `${root.jobId}.root-owner`));
      if (kind === 'symlink-owner-dir') { const d = join(f.run, `${root.jobId}.root-owner`); mkdirSync(`${d}.other`); symlinkSync(`${d}.other`, d); }
      if (kind === 'hardlink') linkSync(base, join(f.dir, 'second-link'));
      if (kind === 'writable-file') chmodSync(line, 0o666);
      if (kind === 'writable-parent') chmodSync(join(f.options.runsDir, 'queue'), 0o777);
      if (kind === 'symlink-parent') { const d = join(f.options.runsDir, 'queue', 'prompts'); renameSync(d, `${d}.original`); symlinkSync(`${d}.original`, d); }
      if (kind === 'worktree-symlink') { const d = join(f.options.worktreeRoot, root.jobId); renameSync(d, `${d}.original`); symlinkSync(`${d}.original`, d); }
      expect(readProtectedAttemptWitness(f.options, root.jobId)).toBeUndefined();
    } finally { f.cleanup(); }
  });
  it.each(['owner-bytes','base-inode','worktree-inode','new-sibling','new-at-final-boot'])('rechecks ownership/coverage through the observation: %s', async kind => {
    const f = fixture(); try {
      const ownerDir = join(f.run, `${root.jobId}.root-owner`); mkdirSync(ownerDir); const owner = join(ownerDir, 'owner.json'); writeFileSync(owner, '{"owner":"/root/first"}', { mode: 0o600 });
      let n = 0; const original = f.deps.readStart;
      f.deps.readStart = async (p, signal) => { if (++n === 2) {
        if (kind === 'owner-bytes') writeFileSync(owner, '{"owner":"/root/other"}');
        if (kind === 'base-inode') { const p = join(f.options.runsDir, `${root.jobId}.base`); renameSync(p, `${p}.old`); writeFileSync(p, readFileSync(`${p}.old`), { mode: 0o600 }); }
        if (kind === 'worktree-inode') { const p = join(f.options.worktreeRoot, root.jobId); renameSync(p, `${p}.old`); mkdirSync(p); }
        if (kind === 'new-sibling') writeFileSync(join(f.run, 'RQ-LATE.dispatched'), '1794000000\n', { mode: 0o600 });
      } return original(p, signal); };
      if (kind === 'new-at-final-boot') { let b = 0; f.deps.readBoot = async () => { if (++b === 2) writeFileSync(join(f.run, 'RQ-LATE.dispatched'), '1794000000\n', { mode: 0o600 }); return 'b'.repeat(64); }; }
      expect((await readVerifiedFleetRoots(f.options, f.deps)).state).toBe('unknown');
    } finally { f.cleanup(); }
  });
  it('ignores elapsed-age drift while retaining exact worker identity', async () => { const f = fixture(); try { let n = 0; f.deps.inspectTargetedWorkers = async () => snapshot([{ ...worker, ageSeconds: ++n }]); expect((await readVerifiedFleetRoots(f.options, f.deps)).state).toBe('known'); } finally { f.cleanup(); } });
  it('bounds and aborts a hung dependency without continuing later observation work', async () => {
    vi.useFakeTimers(); const f = fixture(); try {
      let aborted = false, later = false;
      f.deps.readBoot = signal => new Promise(() => { signal?.addEventListener('abort', () => { aborted = true; }); });
      f.deps.inspectTargetedWorkers = async () => { later = true; return snapshot(); };
      const pending = readVerifiedFleetRoots(f.options, f.deps); await vi.advanceTimersByTimeAsync(5000);
      expect((await pending).state).toBe('unknown'); expect(aborted).toBe(true); expect(later).toBe(false);
    } finally { f.cleanup(); }
  });
});

describe('production root factory with controlled OS IO', () => {
  function production(f: ReturnType<typeof fixture>, platform: 'linux' | 'darwin' = 'linux') {
    const uid = process.getuid?.() ?? 501, calls: Array<{ file: string; args: string[] }> = [];
    const io: MachineRootIo = { platform, uid, readKernelFile: async () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n', command: async (file, args) => {
      calls.push({ file, args });
      if (file === '/usr/sbin/sysctl') return 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n';
      if (file === '/usr/sbin/ioreg') return '"IOPlatformUUID" = "11111111-2222-3333-4444-555555555555"';
      if (args.join(' ') === '-axo pid=,ppid=,uid=,comm=') return `101 1 ${uid} /bin/bash\n999 1 ${uid + 1} /private/Other User/node\n`;
      if (args.some(x => x.includes('command='))) return `101 00:02 /bin/bash ${f.options.runsDir}/bin/launch.sh RQ-TEST phantom codex-cmp work PRIVATE_NOT_EXPORTED\n`;
      if (args.includes('lstart=')) return 'Fri Nov  6 15:00:00 2026\n';
      if (args.includes('uid=')) return `${uid}\n`;
      throw new Error('unexpected command');
    } };
    return { io, calls };
  }
  it.each(['linux','darwin'] as const)('executes the actual %s defaults and keeps targeted argv transient', async platform => {
    const f = fixture(); try { const p = production(f, platform), result = await readVerifiedFleetRoots(f.options, createMachineRootDependencies(f.options, p.io)); expect(result.state).toBe('known'); expect(result.roots).toHaveLength(1); expect(JSON.stringify(result)).not.toContain('PRIVATE_NOT_EXPORTED'); expect(JSON.stringify(result)).not.toContain(f.dir); expect(p.calls.filter(x => x.args.some(x => x.includes('command='))).every(x => x.args.includes('101') && !x.args.includes('999'))).toBe(true); } finally { f.cleanup(); }
  });
  it('uses actual factory census for two roots and a complete known-empty result', async () => {
    const f = fixture(); try {
      f.add('RQ-TWO'); f.status(2); const p = production(f), original = p.io.command;
      p.io.command = async (file, args, signal) => {
        if (args.some(x => x.includes('comm='))) return `101 1 ${p.io.uid} bash\n202 1 ${p.io.uid} bash\n`;
        if (args.some(x => x.includes('command='))) return `101 00:02 /bin/bash ${f.options.runsDir}/bin/launch.sh RQ-TEST phantom codex-cmp work\n202 00:01 /bin/bash ${f.options.runsDir}/bin/launch.sh RQ-TWO phantom codex-cmp work\n`;
        return original(file, args, signal);
      };
      expect((await readVerifiedFleetRoots(f.options, createMachineRootDependencies(f.options, p.io))).roots).toHaveLength(2);
      rmSync(join(f.run, 'RQ-TEST.dispatched')); rmSync(join(f.run, 'RQ-TWO.dispatched')); f.status(0);
      p.io.command = async (_file, args) => { expect(args.some(x => x.includes('command='))).toBe(false); return `999 1 ${p.io.uid + 1} /Other User/node\n`; };
      const empty = await readVerifiedFleetRoots(f.options, createMachineRootDependencies(f.options, p.io)); expect(empty.state).toBe('known'); expect(empty.roots).toEqual([]);
    } finally { f.cleanup(); }
  });
  it('reconciles a genuinely exited inspection candidate without claiming an uninspected live one', async () => {
    const f = fixture(); try {
      rmSync(join(f.run, 'RQ-TEST.dispatched')); f.status(0); const p = production(f); let census = 0;
      p.io.command = async (_file, args) => {
        if (args.some(x => x.includes('comm='))) return ++census === 1 ? `101 1 ${p.io.uid} bash\n` : `999 1 ${p.io.uid + 1} /Other User/node\n`;
        if (args.some(x => x.includes('command='))) return '';
        throw new Error('unexpected command');
      };
      const r = await readVerifiedFleetRoots(f.options, createMachineRootDependencies(f.options, p.io)); expect(r.state).toBe('known'); expect(r.roots).toEqual([]);
    } finally { f.cleanup(); }
  });
  it.each(['missing-target','failed-command','missing-boot','malformed-boot','uid-change','sibling-root','unbound-launcher','argv-body-match','malformed-etime','boot-change','nested-jobs'])('default production path rejects %s', async kind => {
    const f = fixture(); try { const p = production(f), orig = p.io.command;
      if (kind === 'missing-boot') p.io.readKernelFile = async () => null;
      if (kind === 'malformed-boot') p.io.readKernelFile = async () => 'not-a-boot';
      if (kind === 'boot-change') { let boot = 0; p.io.readKernelFile = async () => ++boot === 1 ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' : 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'; }
      if (kind === 'nested-jobs') { f.add('RQ-TWO'); f.status(2); }
      p.io.command = async (file, args, signal) => {
        if (kind === 'failed-command') throw new Error('PRIVATE_OS_ERROR');
        if (kind === 'missing-target' && args.some(x => x.includes('command='))) return '';
        if (kind === 'uid-change' && args.join(' ') === '-p 101 -o uid=') return `${p.io.uid + 1}`;
        if (kind === 'malformed-etime' && args.some(x => x.includes('command='))) return `101 bad /bin/bash ${f.options.runsDir}/bin/launch.sh RQ-TEST phantom codex-cmp work\n`;
        if (kind === 'unbound-launcher' && args.some(x => x.includes('command='))) return '101 00:02 /bin/bash /unrelated/bin/launch.sh RQ-TEST phantom codex-cmp work\n';
        if (kind === 'argv-body-match' && args.some(x => x.includes('command='))) return `101 00:02 /bin/bash -c echo ${f.options.runsDir}/bin/launch.sh RQ-TEST phantom codex-cmp work\n`;
        if (kind === 'nested-jobs' && args.some(x => x.includes('comm='))) return `101 1 ${p.io.uid} bash\n202 101 ${p.io.uid} bash\n`;
        if (kind === 'nested-jobs' && args.some(x => x.includes('command='))) return `101 00:02 /bin/bash ${f.options.runsDir}/bin/launch.sh RQ-TEST phantom codex-cmp work\n202 00:01 /bin/bash ${f.options.runsDir}/bin/launch.sh RQ-TWO phantom codex-cmp work\n`;
        if (kind === 'sibling-root' && args.some(x => x.includes('comm='))) return `101 1 ${p.io.uid} bash\n102 1 ${p.io.uid} bash\n`;
        if (kind === 'sibling-root' && args.some(x => x.includes('command='))) return `101 00:02 /bin/bash ${f.options.runsDir}/bin/launch.sh RQ-TEST phantom codex-cmp work\n102 00:02 /bin/bash ${f.options.runsDir}/bin/launch.sh RQ-TEST phantom codex-cmp work\n`;
        return orig(file, args, signal);
      };
      const r = await readVerifiedFleetRoots(f.options, createMachineRootDependencies(f.options, p.io)); expect(r.state).toBe('unknown'); expect(r.roots).toEqual([]); expect(JSON.stringify(r)).not.toContain('PRIVATE_OS_ERROR');
    } finally { f.cleanup(); }
  });
});
