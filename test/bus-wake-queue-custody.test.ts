/**
 * Real-filesystem custody tests for the wake queue. Only owned temp trees are
 * touched. Races are injected by wrapping node:fs so a swap lands at an exact
 * point (before open / before dedupe read / before write) of the real call.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  chmodSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Hook = (stage: 'open' | 'read' | 'write', path: string | number) => void;
const control: { hook?: Hook } = {};
const queueFds = new Set<number>(); // only the wake-queue descriptors; lock/inbox IO is not intercepted
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const isQueue = (p: unknown) => typeof p === 'string' && p.endsWith('wake-queue.jsonl');
  return {
    ...actual,
    openSync: ((path: any, ...rest: any[]) => {
      if (isQueue(path)) control.hook?.('open', path);
      const fd = (actual.openSync as any)(path, ...rest);
      if (isQueue(path)) queueFds.add(fd);
      return fd;
    }) as typeof actual.openSync,
    closeSync: ((fd: any) => { queueFds.delete(fd); return actual.closeSync(fd); }) as typeof actual.closeSync, // fds are reused
    readSync: ((fd: any, ...rest: any[]) => {
      if (queueFds.has(fd)) control.hook?.('read', fd);
      return (actual.readSync as any)(fd, ...rest);
    }) as typeof actual.readSync,
    writeSync: ((fd: any, ...rest: any[]) => {
      if (queueFds.has(fd)) control.hook?.('write', fd);
      return (actual.writeSync as any)(fd, ...rest);
    }) as typeof actual.writeSync,
  };
});
const { enqueueBusWake, readBusWakes, busWakeQueuePath } = await import('../src/core/fleet/bus-wake-queue.js');
const { publishChannelEnvelope } = await import('../src/core/fleet/channel-bus-publish.js');

const trees: string[] = [];
const tree = () => { const v = realpathSync(mkdtempSync(join(tmpdir(), 'wake-custody-'))); trees.push(v); return v; };
beforeEach(() => { control.hook = undefined; queueFds.clear(); });
afterEach(() => {
  control.hook = undefined;
  for (const t of trees.splice(0)) { try { chmodSync(t, 0o700); } catch { /* gone */ } rmSync(t, { recursive: true, force: true }); }
});
const request = { kind: 'bus.send' as const, id: 'fake-id', from: 'mason', to: 'leaders', body: 'fake interjection' };
const other = { ...request, id: 'other-id' };
const mode = (p: string) => lstatSync(p).mode & 0o7777;
/** Owner-owned sentinel standing in for a file outside the queue. */
function sentinel(dir: string, content = 'SENTINEL\n') {
  mkdirSync(dir, { mode: 0o700 }); const file = join(dir, 'wake-queue.jsonl');
  writeFileSync(file, content, { mode: 0o600 }); return file;
}
const untouched = (file: string, content = 'SENTINEL\n') => expect(readFileSync(file, 'utf8')).toBe(content);

it('uses a 0755 protected parent with a strict 0700 bus child, leaving the parent mode unchanged', () => {
  const root = tree(); chmodSync(root, 0o755);
  expect(enqueueBusWake(request, { root, now: () => 7 })).toBe('queued');
  expect(enqueueBusWake(request, { root, now: () => 8 })).toBe('duplicate');
  expect(mode(root)).toBe(0o755);
  expect(mode(join(root, 'bus'))).toBe(0o700);
  expect(mode(busWakeQueuePath(root))).toBe(0o600);
  expect(readBusWakes({ root })).toEqual({ state: 'ok', wakes: [{ kind: 'bus.send', id: 'fake-id', from: 'mason', to: 'leaders', at: 7 }] });
  expect(mode(root)).toBe(0o755);
});

it('preserves an accepted default inbox while ASHLR_RUNS_DIR points at a separate 0755 wake root', async () => {
  const home = tree(), runs = join(home, 'runs'); mkdirSync(runs, { mode: 0o755 }); chmodSync(runs, 0o755);
  const saved = { HOME: process.env['HOME'], runs: process.env['ASHLR_RUNS_DIR'] };
  process.env['HOME'] = home; process.env['ASHLR_RUNS_DIR'] = runs;
  try {
    const envelope = { channel: 'desktop' as const, verifiedSenderId: 'fake-mason', receivedAt: new Date(0).toISOString(), dedupeKey: 'a'.repeat(64), body: 'fake interjection' };
    expect(await publishChannelEnvelope(envelope, {})).toBe('published');
    expect(readBusWakes({}).state).toBe('ok');
    expect(readBusWakes({}).wakes).toHaveLength(1);
    expect(mode(runs)).toBe(0o755);
  } finally {
    for (const [key, value] of [['HOME', saved.HOME], ['ASHLR_RUNS_DIR', saved.runs]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

it.each([0o775, 0o757, 0o777])('refuses a group/world-writable parent (%o) without creating or chmodding', mask => {
  const root = tree(); chmodSync(root, mask);
  expect(() => enqueueBusWake(request, { root })).toThrow();
  expect(readBusWakes({ root }).state).toBe('unreadable');
  expect(existsSync(join(root, 'bus'))).toBe(false);
  expect(mode(root)).toBe(mask);
});

it('refuses a symlink parent and writes nothing through it', () => {
  const base = tree(), real = join(base, 'real'), link = join(base, 'link');
  mkdirSync(real, { mode: 0o755 }); chmodSync(real, 0o755); symlinkSync(real, link);
  expect(() => enqueueBusWake(request, { root: link })).toThrow();
  expect(readBusWakes({ root: link }).state).toBe('unreadable');
  expect(readdirSync(real)).toEqual([]);
});

it.each([0o755, 0o770, 0o710])('refuses a non-0700 bus child (%o) without normalizing its mode', childMode => {
  const root = tree(); chmodSync(root, 0o755);
  mkdirSync(join(root, 'bus')); chmodSync(join(root, 'bus'), childMode);
  expect(() => enqueueBusWake(request, { root })).toThrow();
  expect(readBusWakes({ root }).state).toBe('unreadable');
  expect(mode(join(root, 'bus'))).toBe(childMode);
  expect(readdirSync(join(root, 'bus'))).toEqual([]);
});

it('detects a bus directory swapped to an external symlink before the queue open', () => {
  const base = tree(), root = join(base, 'r'); mkdirSync(root, { mode: 0o755 }); chmodSync(root, 0o755);
  const outside = sentinel(join(base, 'outside'));
  expect(enqueueBusWake(request, { root, now: () => 1 })).toBe('queued');
  let swapped = false;
  control.hook = (stage, path) => {
    if (stage !== 'open' || swapped) return; swapped = true;
    renameSync(join(root, 'bus'), join(base, 'moved-bus'));
    symlinkSync(join(base, 'outside'), join(root, 'bus'));
    expect(path).toContain('wake-queue.jsonl');
  };
  expect(() => enqueueBusWake(other, { root, now: () => 2 })).toThrow();
  untouched(outside);
  expect(readFileSync(join(base, 'moved-bus', 'wake-queue.jsonl'), 'utf8')).not.toContain('other-id');
  control.hook = undefined;
  expect(readBusWakes({ root }).state).toBe('unreadable'); // still a symlink: never healthy
});

it('detects a bus directory swapped for a real directory holding a lookalike queue', () => {
  const base = tree(), root = join(base, 'r'); mkdirSync(root, { mode: 0o755 }); chmodSync(root, 0o755);
  expect(enqueueBusWake(request, { root, now: () => 1 })).toBe('queued');
  const decoy = join(base, 'decoy');
  const outside = sentinel(decoy);
  let swapped = false;
  control.hook = stage => {
    if (stage !== 'open' || swapped) return; swapped = true;
    renameSync(join(root, 'bus'), join(base, 'moved-bus'));
    renameSync(decoy, join(root, 'bus')); // real 0700 directory, different identity from the pin
  };
  expect(() => enqueueBusWake(other, { root, now: () => 2 })).toThrow();
  untouched(join(root, 'bus', 'wake-queue.jsonl'));
  void outside;
});

it('rejects a reader whose directory is swapped between open and read (no false healthy read)', () => {
  const base = tree(), root = join(base, 'r'); mkdirSync(root, { mode: 0o755 }); chmodSync(root, 0o755);
  expect(enqueueBusWake(request, { root, now: () => 1 })).toBe('queued');
  let swapped = false;
  control.hook = stage => {
    if (stage !== 'read' || swapped) return; swapped = true;
    renameSync(join(root, 'bus'), join(base, 'moved-bus'));
    mkdirSync(join(root, 'bus'), { mode: 0o700 });
  };
  expect(readBusWakes({ root })).toEqual({ state: 'unreadable', wakes: [] });
});

it('refuses a queue file name swapped to an external symlink before open; sentinel is untouched', () => {
  const base = tree(), root = join(base, 'r'); mkdirSync(root, { mode: 0o755 }); chmodSync(root, 0o755);
  const outside = sentinel(join(base, 'outside'));
  expect(enqueueBusWake(request, { root, now: () => 1 })).toBe('queued');
  let swapped = false;
  control.hook = stage => {
    if (stage !== 'open' || swapped) return; swapped = true;
    const queue = busWakeQueuePath(root);
    renameSync(queue, join(base, 'moved-queue')); symlinkSync(outside, queue);
  };
  expect(() => enqueueBusWake(other, { root, now: () => 2 })).toThrow();
  untouched(outside);
  expect(readBusWakes({ root }).state).toBe('unreadable');
});

it('refuses a queue file swapped for a hardlink to an external file before open', () => {
  const base = tree(), root = join(base, 'r'); mkdirSync(root, { mode: 0o755 }); chmodSync(root, 0o755);
  const outside = sentinel(join(base, 'outside'));
  expect(enqueueBusWake(request, { root, now: () => 1 })).toBe('queued');
  let swapped = false;
  control.hook = stage => {
    if (stage !== 'open' || swapped) return; swapped = true;
    const queue = busWakeQueuePath(root);
    renameSync(queue, join(base, 'moved-queue')); require_link(outside, queue);
  };
  expect(() => enqueueBusWake(other, { root, now: () => 2 })).toThrow();
  untouched(outside);
});

it('does not report duplicate or queued when the queue name is swapped after open, before dedupe/write', () => {
  const base = tree(), root = join(base, 'r'); mkdirSync(root, { mode: 0o755 }); chmodSync(root, 0o755);
  expect(enqueueBusWake(request, { root, now: () => 1 })).toBe('queued');
  const outside = sentinel(join(base, 'outside'));
  const queue = busWakeQueuePath(root);
  // (a) swap before the dedupe read: the old inode already holds the id, the new name does not.
  let swapped = false;
  control.hook = stage => {
    if (stage !== 'read' || swapped) return; swapped = true;
    renameSync(queue, join(base, 'orphan-a')); writeFileSync(queue, '', { mode: 0o600 });
  };
  expect(() => enqueueBusWake(request, { root, now: () => 2 })).toThrow(); // never a false 'duplicate'
  control.hook = undefined;
  expect(readBusWakes({ root }).wakes).toEqual([]);
  // (b) swap after dedupe, immediately before the write: write lands on the orphan, must not be 'queued'.
  rmSync(queue); rmSync(join(base, 'orphan-a'));
  expect(enqueueBusWake(request, { root, now: () => 3 })).toBe('queued');
  swapped = false;
  control.hook = stage => {
    if (stage !== 'write' || swapped) return; swapped = true;
    renameSync(queue, join(base, 'orphan-b')); symlinkSync(outside, queue);
  };
  expect(() => enqueueBusWake(other, { root, now: () => 4 })).toThrow(); // never a false 'queued'
  control.hook = undefined;
  untouched(outside);
  expect(readBusWakes({ root }).state).toBe('unreadable');
});

function require_link(from: string, to: string) { linkSyncCompat(from, to); }
import { linkSync as linkSyncCompat } from 'node:fs';

// Bounded observed residual: a same-owner parent swap before pathname O_CREAT
// can create an empty 0600 fixed-basename file in a substituted directory. The
// post-open check refuses. A separate below test captures append-to-relocated-
// original-inode behavior; neither case establishes whole-call confinement.
it('LIMITATION: a parent swap at the first create-open leaves an actual empty private fixed-basename file before refusal', () => {
  const base = tree(), root = join(base, 'r'); mkdirSync(root, { mode: 0o755 }); chmodSync(root, 0o755);
  mkdirSync(join(base, 'outside'), { mode: 0o700 });
  mkdirSync(join(root, 'bus'), { mode: 0o700 });
  let swapped = false;
  control.hook = stage => {
    if (stage !== 'open' || swapped) return; swapped = true;
    renameSync(join(root, 'bus'), join(base, 'moved-bus')); symlinkSync(join(base, 'outside'), join(root, 'bus'));
  };
  expect(() => enqueueBusWake(request, { root, now: () => 1 })).toThrow();
  const created = join(base, 'outside', 'wake-queue.jsonl');
  expect(existsSync(created)).toBe(true);
  const createdStat = lstatSync(created);
  expect(createdStat.isFile()).toBe(true);
  expect(createdStat.isSymbolicLink()).toBe(false);
  expect(createdStat.mode & 0o7777).toBe(0o600);
  expect(createdStat.size).toBe(0);
  expect(readFileSync(created, 'utf8')).toBe('');
});

it('LIMITATION: a directory moved immediately before append receives routing IDs on the original inode while the substituted sentinel remains untouched and the call refuses', () => {
  const base = tree(), root = join(base, 'r'); mkdirSync(root, { mode: 0o755 }); chmodSync(root, 0o755);
  expect(enqueueBusWake(request, { root, now: () => 1 })).toBe('queued');
  const queue = busWakeQueuePath(root), original = lstatSync(queue, { bigint: true });
  const decoy = join(base, 'decoy'), moved = join(base, 'relocated-original-bus');
  sentinel(decoy);
  let swapped = false;
  control.hook = (stage, fd) => {
    if (stage !== 'write' || swapped) return;
    expect(typeof fd).toBe('number');
    const opened = fstatSync(fd as number, { bigint: true });
    expect([opened.dev, opened.ino]).toEqual([original.dev, original.ino]);
    swapped = true;
    renameSync(join(root, 'bus'), moved);
    renameSync(decoy, join(root, 'bus'));
  };
  expect(() => enqueueBusWake(other, { root, now: () => 2 })).toThrow();
  expect(swapped).toBe(true); control.hook = undefined;
  const relocated = join(moved, 'wake-queue.jsonl'), relocatedStat = lstatSync(relocated, { bigint: true });
  expect([relocatedStat.dev, relocatedStat.ino]).toEqual([original.dev, original.ino]);
  expect(readFileSync(relocated, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
    { kind: 'bus.send', id: 'fake-id', from: 'mason', to: 'leaders', at: 1 },
    { kind: 'bus.send', id: 'other-id', from: 'mason', to: 'leaders', at: 2 },
  ]);
  expect(readFileSync(relocated, 'utf8')).not.toContain('fake interjection');
  untouched(busWakeQueuePath(root));
  const substituted = lstatSync(busWakeQueuePath(root), { bigint: true });
  expect([substituted.dev, substituted.ino]).not.toEqual([original.dev, original.ino]);
});
