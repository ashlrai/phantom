/** Actual guarded ledger reads and production commits; no task/provider/native invocation. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { readResourceJson, readResourcePoolAllocation, resourcePoolStatus, setResourcePoolAllocation,
  setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { applyResourcePoolEvolution, checkResourcePoolEvolution } from '../src/core/resources/pool-evolution.js';
import * as writes from '../src/core/util/private-file-write.js';

const roots: string[] = [];
const owners: ResourcePoolSupervisor[] = [];
const restores: Array<() => void> = [];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const identity = (s: fs.Stats) => ({ dev: String(s.dev), ino: String(s.ino) });

beforeEach(() => { expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME); });
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  syncBuiltinESMExports();
  for (const owner of owners.splice(0)) await owner.close().catch(() => {});
  // Only fresh test-owned roots are registered; never derive cleanup paths from ledger data.
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(withOwner = true) {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pool-read-generation-')));
  fs.chmodSync(base, 0o700); roots.push(base);
  const workspace = join(base, 'workspace'); fs.mkdirSync(workspace, { mode: 0o700 });
  const root = join(base, 'ledger');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'read-generation', workers: [{
    id: 'local', provider: 'local', model: 'inert', maxConcurrent: 1, maxTasksPerWindow: 8,
    taskWindowMs: 3_600_000, reservePercent: 25, priority: 1,
  }] });
  const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'local',
    kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }], pool);
  // Initialize and publish through the actual transaction; no receipt or accepted state is invented.
  const initial = setResourcePoolAllocation(root, pool, bindings, 75, 0);
  expect(initial.revision).toBe(1);
  const before = resourcePoolStatus(root, pool, bindings, []);
  expect(before.attempts).toEqual([]);
  const owner = withOwner ? await createResourcePoolSupervisor({ root, workspace, pool, bindings,
    readObservations: () => [] }) : null;
  if (owner) { owners.push(owner); expect(owner.snapshot()).toMatchObject({ error: null, jobs: [] }); }
  return { base, workspace, root, pool, bindings, initial, before, owner, file: join(root, 'pool-state.json') };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Force one exact interleaving after the original syscall, without faking bytes/counts or nested writer reads. */
function duringRead(f: Fixture, effect: (readNumber: number) => void, maximumEffects = 1) {
  const original = fs.readSync;
  let reads = 0, effects = 0, insideEffect = false;
  const spy = vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(original, fs, args) as number;
    const opened = fs.fstatSync(args[0]);
    const named = fs.lstatSync(f.file);
    if (!insideEffect && opened.dev === named.dev && opened.ino === named.ino) {
      reads++;
      if (effects < maximumEffects) {
        effects++; insideEffect = true;
        try { effect(reads); } finally { insideEffect = false; }
      }
    }
    return count;
  });
  syncBuiltinESMExports();
  let restored = false;
  const restore = () => { if (restored) return; restored = true; spy.mockRestore(); syncBuiltinESMExports(); };
  restores.push(restore);
  return { restore, reads: () => reads, effects: () => effects };
}
function publishNext(f: Fixture, expectedRevision = f.initial.revision) {
  return setResourcePoolAllocation(f.root, f.pool, f.bindings, 60, expectedRevision);
}
function unchangedPolicies(f: Fixture) {
  const state = resourcePoolStatus(f.root, f.pool, f.bindings, []);
  expect(state.attempts).toEqual(f.before.attempts);
  expect(state.quotaScopeAccess).toEqual(f.before.quotaScopeAccess);
  return state;
}

describe.runIf(process.platform === 'darwin')('owned ledger publication during supervisor reads', () => {
  it('observes an ordinary production revision without any injected read race', async () => {
    const f = await fixture(); const next = publishNext(f);
    expect(next.revision).toBe(2);
    expect(readResourcePoolAllocation(f.root, f.pool, f.bindings)).toEqual(next);
    expect(f.owner!.snapshot()).toMatchObject({ error: null, jobs: [] });
    unchangedPolicies(f);
  });

  it('retains a real fresh policy revision after one valid atomic replacement without faulting the owner', async () => {
    const f = await fixture(); const before = fs.lstatSync(f.file), bytesBefore = fs.readFileSync(f.file);
    const lock = fs.lstatSync(join(f.root, '.resource-console.lock'));
    let published: ReturnType<typeof publishNext> | undefined;
    const hook = duringRead(f, () => {
      published = publishNext(f);
      setResourceWorkerAccess(f.root, f.pool, f.bindings, ['local'], 0);
    });
    const observation = f.owner!.snapshot(); hook.restore();
    expect(hook.effects()).toBe(1); expect(hook.reads()).toBe(2);
    expect(identity(fs.lstatSync(f.file))).not.toEqual(identity(before));
    expect(digest(fs.readFileSync(f.file))).not.toBe(digest(bytesBefore));
    expect(published).toMatchObject({ revision: 2, ceilingPercent: 60 });
    expect(readResourcePoolAllocation(f.root, f.pool, f.bindings)).toEqual(published);
    const current = unchangedPolicies(f);
    expect(current.workerAccess).toMatchObject({ revision: 1, pausedWorkerIds: ['local'] });
    expect(identity(fs.lstatSync(join(f.root, '.resource-console.lock')))).toEqual(identity(lock));
    expect(observation).toMatchObject({ error: null, jobs: [] });
    expect(f.owner!.snapshot().error).toBeNull();
  });

  it('keeps the public configuration reader strict rather than silently retrying replacement', async () => {
    const f = await fixture(false);
    const hook = duringRead(f, () => { publishNext(f); });
    expect(() => readResourceJson(f.file)).toThrow(); hook.restore();
    expect(hook.effects()).toBe(1); expect(hook.reads()).toBe(1);
    expect(readResourcePoolAllocation(f.root, f.pool, f.bindings)).toMatchObject({ revision: 2, ceilingPercent: 60 });
  });

  it('exhausts exactly three total guarded pool reads under genuine continuing publication', async () => {
    const f = await fixture(); let revision = f.initial.revision;
    const hook = duringRead(f, () => { revision = publishNext(f, revision).revision; }, 10);
    const observation = f.owner!.snapshot(); hook.restore();
    expect(hook.effects()).toBe(3); expect(hook.reads()).toBe(3); expect(revision).toBe(4);
    expect(readResourcePoolAllocation(f.root, f.pool, f.bindings)).toMatchObject({ revision: 4, ceilingPercent: 60 });
    expect(observation.error).toBe('supervisor-commissioning-custody-unavailable');
    unchangedPolicies(f);
  });

  it('does not hide malformed captured bytes behind a later valid production-generated replacement', async () => {
    const f = await fixture(false), replacement = await fixture(false);
    publishNext(replacement);
    // Hostile captured input, followed by real valid bytes from another owned software fixture.
    fs.writeFileSync(f.file, '{broken\n');
    const hook = duringRead(f, () => { fs.renameSync(replacement.file, f.file); });
    expect(() => readResourcePoolAllocation(f.root, f.pool, f.bindings)).toThrow(); hook.restore();
    expect(hook.effects()).toBe(1); expect(hook.reads()).toBe(1);
    expect(readResourcePoolAllocation(f.root, f.pool, f.bindings)).toMatchObject({ revision: 2, ceilingPercent: 60 });
  });

  it.each(['same-size', 'size', 'mtime'] as const)('refuses in-place %s mutation without retrying', async kind => {
    const f = await fixture(false); const before = fs.lstatSync(f.file);
    const hook = duringRead(f, () => {
      if (kind === 'mtime') fs.utimesSync(f.file, new Date(), new Date(before.mtimeMs + 2000));
      else if (kind === 'size') fs.appendFileSync(f.file, ' ');
      else {
        const bytes = fs.readFileSync(f.file, 'utf8');
        expect(bytes).toContain('"ceilingPercent":75');
        fs.writeFileSync(f.file, bytes.replace('"ceilingPercent":75', '"ceilingPercent":74'));
        fs.utimesSync(f.file, new Date(), new Date(before.mtimeMs + 2000));
      }
    });
    expect(() => readResourcePoolAllocation(f.root, f.pool, f.bindings)).toThrow(); hook.restore();
    expect(hook.reads()).toBe(1); expect(identity(fs.lstatSync(f.file))).toEqual(identity(before));
  });

  it.each(['mode', 'hardlink', 'symlink', 'oversized', 'malformed', 'schema'] as const)(
    'refuses replacement with unsafe %s instead of qualifying it as ordinary publication', async kind => {
      const f = await fixture(false);
      const hook = duringRead(f, () => {
        publishNext(f);
        if (kind === 'mode') fs.chmodSync(f.file, 0o604);
        else if (kind === 'hardlink') fs.linkSync(f.file, join(f.root, 'extra-link'));
        else if (kind === 'symlink') {
          const retained = join(f.root, 'retained.json'); fs.renameSync(f.file, retained); fs.symlinkSync(retained, f.file);
        } else if (kind === 'oversized') fs.writeFileSync(f.file, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
        else if (kind === 'malformed') fs.writeFileSync(f.file, '{broken\n');
        else {
          const state = JSON.parse(fs.readFileSync(f.file, 'utf8'));
          state.schemaVersion = 99; fs.writeFileSync(f.file, JSON.stringify(state));
        }
      });
      expect(() => readResourcePoolAllocation(f.root, f.pool, f.bindings)).toThrow(); hook.restore();
      expect(hook.effects()).toBe(1);
      expect(() => readResourcePoolAllocation(f.root, f.pool, f.bindings)).toThrow();
    });

  it('refuses a foreign-owner stat without retry; the observed-owner port is a denial fixture only', async () => {
    const f = await fixture(false); const original = fs.lstatSync;
    // Unprivileged tests cannot safely chown to another account. Only the observed UID is made hostile;
    // every syscall still runs, and this seam can never supply accepted owner/account evidence.
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = Reflect.apply(original, fs, args);
      if (args[0] === f.file) Object.assign(stat, { uid: typeof stat.uid === 'bigint' ? stat.uid + 1n : stat.uid + 1 });
      return stat;
    }) as typeof fs.lstatSync);
    restores.push(() => spy.mockRestore()); syncBuiltinESMExports();
    expect(() => readResourcePoolAllocation(f.root, f.pool, f.bindings)).toThrow();
    spy.mockRestore(); syncBuiltinESMExports();
    expect(readResourcePoolAllocation(f.root, f.pool, f.bindings)).toEqual(f.initial);
  });

  it('retains a genuine interrupted evolution barrier when it becomes the new read generation', async () => {
    const f = await fixture(false), barrier = await fixture(false);
    const nextPool = validateResourcePool({ ...barrier.pool, workers: [...barrier.pool.workers,
      { ...barrier.pool.workers[0]!, id: 'extra' }] });
    const nextBindings = validateResourceBindings([...barrier.bindings,
      { ...barrier.bindings[0]!, workerId: 'extra', capacityKey: 'extra', endpoint: 'http://127.0.0.1:2/v1' }], nextPool);
    const options = { root: barrier.root, workspace: barrier.workspace, pool: barrier.pool,
      bindings: barrier.bindings, nextPool, nextBindings };
    const plan = checkResourcePoolEvolution(options); const original = writes.writePrivateFileAtomically;
    let stopped = false;
    const spy = vi.spyOn(writes, 'writePrivateFileAtomically').mockImplementation((temporary, target, bytes, options) => {
      original(temporary, target, bytes, options);
      if (target === barrier.file && String(bytes).includes('pendingEvolution')) {
        stopped = true; throw new Error('test interruption after actual durable barrier');
      }
    });
    restores.push(() => spy.mockRestore());
    expect(() => applyResourcePoolEvolution({ ...options, expectedPlanDigest: plan.planDigest })).toThrow();
    spy.mockRestore(); expect(stopped).toBe(true);
    expect(JSON.parse(fs.readFileSync(barrier.file, 'utf8')).pendingEvolution).toBeDefined();
    const hook = duringRead(f, () => { fs.renameSync(barrier.file, f.file); });
    // The production barrier already names the next configuration. Read that exact scope so
    // rejection proves pending settlement, rather than the earlier active-configuration guard.
    expect(() => readResourcePoolAllocation(f.root, nextPool, nextBindings)).toThrow(/pending/); hook.restore();
    expect(hook.effects()).toBe(1); expect(hook.reads()).toBe(2);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).pendingEvolution).toBeDefined();
  });

  it('does not skip strong custody after a valid replacement introduces unknown retained transition bytes', async () => {
    const f = await fixture(); const parent = join(f.root, 'pool-commissioning'), unknown = join(parent, 'unknown-request');
    const hook = duringRead(f, () => {
      publishNext(f);
      fs.mkdirSync(unknown, { recursive: true, mode: 0o700 }); fs.chmodSync(parent, 0o700);
      fs.writeFileSync(join(unknown, 'journal.json'), 'UNKNOWN_RETAINED_BYTES\n', { mode: 0o600 });
    });
    const observation = f.owner!.snapshot(); hook.restore();
    expect(hook.effects()).toBe(1);
    expect(observation.error).toBe('supervisor-commissioning-custody-unavailable');
    expect(() => readResourcePoolAllocation(f.root, f.pool, f.bindings)).toThrow(/custody/);
    expect(fs.readFileSync(join(unknown, 'journal.json'), 'utf8')).toBe('UNKNOWN_RETAINED_BYTES\n');
    // Completed native journal/ready/profile negatives remain in the existing commissioning suites.
    // This is an inert unknown-custody refusal, never positive native/account qualification.
  });
});
