import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  acquireTscSlot, reclaimStaleTscSlot, tscSlotCount, tscSlotsDir, withTscSlot,
} from './verify-changed.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'verify-tsc-slots-'));
  return { slots: join(root, 'phantom-tsc-slots'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// A controllable liveness probe plus a fake clock so waits are deterministic.
function harness() {
  const live = new Set();
  let now = 0;
  const reclaim = (path) => reclaimStaleTscSlot(path, { alive: (pid) => live.has(pid) });
  return {
    live,
    clock: () => now,
    options: (pid, overrides = {}) => ({
      count: 3,
      pid,
      reclaim,
      now: () => now,
      sleep: (ms) => { now += ms; },
      pollMs: 10,
      maxWaitMs: 100,
      ...overrides,
    }),
  };
}

test('caps concurrent holders at the slot count until one frees', () => {
  const { slots, cleanup } = fixture();
  try {
    const h = harness();
    const held = [];
    for (const pid of [101, 102, 103]) {
      h.live.add(pid);
      held.push(acquireTscSlot(slots, h.options(pid)));
    }
    assert.deepEqual(held.map((slot) => slot.index), [0, 1, 2]);

    // The cap holds: a fourth holder waits the bounded poll, gets nothing.
    assert.equal(acquireTscSlot(slots, h.options(104)), null);
    assert.ok(h.clock() <= 100, 'bounded poll must stop at maxWaitMs');
    assert.deepEqual(readdirSync(slots).sort(), ['slot-0', 'slot-1', 'slot-2']);

    // Freeing one slot lets the next holder in.
    held[0].release();
    const fourth = acquireTscSlot(slots, h.options(104));
    assert.equal(fourth.index, 0);
    assert.equal(readFileSync(join(slots, 'slot-0', 'pid'), 'utf8'), '104\n');
  } finally {
    cleanup();
  }
});

test('reclaims a slot whose holder pid is gone', () => {
  const { slots, cleanup } = fixture();
  try {
    const h = harness();
    for (const pid of [201, 202, 203]) {
      acquireTscSlot(slots, h.options(pid));
      h.live.add(pid);
    }
    h.live.delete(202); // holder of slot-1 died without releasing
    const slot = acquireTscSlot(slots, h.options(204));
    assert.equal(slot.index, 1);
    assert.equal(readFileSync(join(slots, 'slot-1', 'pid'), 'utf8'), '204\n');
    assert.equal(readFileSync(join(slots, 'slot-0', 'pid'), 'utf8'), '201\n');
    assert.equal(readFileSync(join(slots, 'slot-2', 'pid'), 'utf8'), '203\n');
  } finally {
    cleanup();
  }
});

test('ignores a fresh pid-less slot but recovers an aged one', () => {
  const { slots, cleanup } = fixture();
  try {
    const slotPath = join(slots, 'slot-0');
    mkdirSync(slotPath, { recursive: true });
    const dead = { alive: () => false, now: Date.now, graceMs: 30_000 };
    assert.equal(reclaimStaleTscSlot(slotPath, dead), false);
    utimesSync(slotPath, new Date(0), new Date(0));
    assert.equal(reclaimStaleTscSlot(slotPath, dead), true);
    assert.equal(existsSync(slotPath), false);
  } finally {
    cleanup();
  }
});

test('frees the slot when the held check throws and when it finishes', () => {
  const { slots, cleanup } = fixture();
  try {
    const h = harness();
    const fakeTypecheck = () => { throw new Error('tsc failed'); };
    assert.throws(() => withTscSlot(slots, h.options(301), fakeTypecheck), /tsc failed/);
    assert.equal(existsSync(join(slots, 'slot-0')), false);
    assert.equal(readdirSync(slots).length, 0);

    const outcome = withTscSlot(slots, h.options(302), () => 'typecheck ran');
    assert.deepEqual(outcome, { acquired: true, result: 'typecheck ran' });
    assert.equal(readdirSync(slots).length, 0);
  } finally {
    cleanup();
  }
});

test('reports not acquired rather than run the check over the cap', () => {
  const { slots, cleanup } = fixture();
  try {
    const h = harness();
    for (const pid of [401, 402, 403]) {
      acquireTscSlot(slots, h.options(pid));
      h.live.add(pid);
    }
    let ran = false;
    const outcome = withTscSlot(slots, h.options(404), () => { ran = true; });
    assert.equal(ran, false);
    assert.deepEqual(outcome, { acquired: false });
  } finally {
    cleanup();
  }
});

test('PHANTOM_TSC_SLOTS overrides the default of three', () => {
  assert.equal(tscSlotCount({}), 3);
  assert.equal(tscSlotCount({ PHANTOM_TSC_SLOTS: '' }), 3);
  assert.equal(tscSlotCount({ PHANTOM_TSC_SLOTS: '1' }), 1);
  assert.equal(tscSlotCount({ PHANTOM_TSC_SLOTS: '8' }), 8);
  for (const bad of ['0', '-2', 'two', '1.5', '65']) {
    assert.throws(() => tscSlotCount({ PHANTOM_TSC_SLOTS: bad }), /PHANTOM_TSC_SLOTS/);
  }
});

test('slots resolve beside the shared root that PHANTOM_TSC_CACHE_DIR uses', () => {
  assert.equal(
    tscSlotsDir('/repo', { PHANTOM_TSC_CACHE_DIR: '/shared/tsc-cache' }),
    resolve('/shared/phantom-tsc-slots'),
  );
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, args]);
    return ' .git\n';
  };
  assert.equal(tscSlotsDir('/repo', {}, exec), resolve('/repo/.git/phantom-tsc-slots'));
  assert.deepEqual(calls, [['git', ['rev-parse', '--git-common-dir']]]);
});

test('leaves no slot dirs behind after release', () => {
  const { slots, cleanup } = fixture();
  try {
    const h = harness();
    const slot = acquireTscSlot(slots, h.options(501));
    slot.release();
    slot.release();
    assert.equal(readdirSync(slots).length, 0);
  } finally {
    cleanup();
  }
});
