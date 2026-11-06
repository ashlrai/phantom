/**
 * RQ-PHX-PLANNERAUTORUN01 — the pure autorun decision and its input read.
 * Every reason is pinned in its fixed precedence order. The queued supply is
 * delegated to ready-supply.ts (the canonical count of every parked-row form
 * ready.tsv carries); the row-level cases here exercise it end-to-end through
 * real files, including the dispatcher's third-column PARKED lane marker.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decidePlannerAutorun, readPlannerAutorunInput, type PlannerAutorunInput,
} from './planner-autorun.js';
import type { PlannerHealth } from './planner-failover.js';

// Fixed local clock: Nov 1 2026 12:00. Fixture stamps sit relative to it.
const NOW = new Date(2026, 10, 1, 12, 0, 0).getTime();
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();
const pad2 = (n: number): string => String(n).padStart(2, '0');
const localStamp = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

const okHealth = (lastGoodPassAt: string | null): PlannerHealth =>
  ({ status: 'ok', failingSince: null, lastGoodPassAt, resetAt: null, reason: null });
const unknownHealth = (): PlannerHealth =>
  ({ status: 'unknown', failingSince: null, lastGoodPassAt: null, resetAt: null, reason: 'missing-events-log' });
const failingHealth = (reason: string): PlannerHealth =>
  ({ status: 'failing', failingSince: minutesAgo(30), lastGoodPassAt: null, resetAt: null, reason });
const freeLane = { lane: 'codex-personal', running: 1, target: 3, held: false };

const input = (over: Partial<PlannerAutorunInput> = {}): PlannerAutorunInput => ({
  phxReady: 3,
  lanes: [freeLane],
  health: okHealth(minutesAgo(60)),
  orchOff: false,
  nowMs: NOW,
  ...over,
});

describe('decidePlannerAutorun — fixed check order', () => {
  it('orch-off beats every other signal', () => {
    const d = decidePlannerAutorun(input({ orchOff: true, health: failingHealth('usage-limit'), lanes: [] }));
    expect(d).toMatchObject({ v: 1, run: false, reason: 'orch-off' });
    expect(d.detail).toContain('ORCH_OFF');
  });

  it('planner-failing beats slot and supply checks, and names the reason', () => {
    const d = decidePlannerAutorun(input({ health: failingHealth('usage-limit'), lanes: [], phxReady: 100 }));
    expect(d).toMatchObject({ run: false, reason: 'planner-failing' });
    expect(d.detail).toContain('usage-limit');
  });

  it('no-free-slots beats enough supply', () => {
    const d = decidePlannerAutorun(input({
      phxReady: 100,
      lanes: [{ lane: 'devin', running: 2, target: 2, held: false }, { lane: 'claude', running: 0, target: 1, held: true }],
    }));
    expect(d).toMatchObject({ run: false, reason: 'no-free-slots', freeSlots: 0 });
  });

  it('enough-supply beats a recent pass', () => {
    const d = decidePlannerAutorun(input({ phxReady: 30, health: okHealth(minutesAgo(2)) }));
    expect(d).toMatchObject({ run: false, reason: 'enough-supply', phxReady: 30 });
  });

  it('too-soon reports the pass age', () => {
    const d = decidePlannerAutorun(input({ phxReady: 3, health: okHealth(minutesAgo(10)) }));
    expect(d).toMatchObject({ run: false, reason: 'too-soon', minutesSinceLastPass: 10 });
  });

  it('low-supply runs once supply, slots and the gap all line up', () => {
    const d = decidePlannerAutorun(input({ phxReady: 3, health: okHealth(minutesAgo(60)) }));
    expect(d).toMatchObject({ run: true, reason: 'low-supply', phxReady: 3, freeSlots: 2, minutesSinceLastPass: 60 });
    expect(d.lastPassAt).toBe(minutesAgo(60));
  });
});

describe('decidePlannerAutorun — defaults and edge inputs', () => {
  it('defaults to a 24-job floor: 23 is low, 24 is enough', () => {
    expect(decidePlannerAutorun(input({ phxReady: 23 })).reason).toBe('low-supply');
    expect(decidePlannerAutorun(input({ phxReady: 24 })).reason).toBe('enough-supply');
  });

  it('defaults to a 25-minute gap: 24 minutes is too soon, 25 is due', () => {
    expect(decidePlannerAutorun(input({ health: okHealth(minutesAgo(24)) })).reason).toBe('too-soon');
    expect(decidePlannerAutorun(input({ health: okHealth(minutesAgo(25)) })).reason).toBe('low-supply');
  });

  it('honors explicit thresholds', () => {
    expect(decidePlannerAutorun(input({ lowSupply: 2, phxReady: 3 })).reason).toBe('enough-supply');
    expect(decidePlannerAutorun(input({ minGapMinutes: 120, health: okHealth(minutesAgo(60)) })).reason).toBe('too-soon');
  });

  it('a last pass that cannot be proven recent is never too soon', () => {
    expect(decidePlannerAutorun(input({ health: unknownHealth() })))
      .toMatchObject({ run: true, lastPassAt: null, minutesSinceLastPass: null });
    expect(decidePlannerAutorun(input({ health: okHealth('not-a-date') })))
      .toMatchObject({ run: true, minutesSinceLastPass: null });
  });

  it('a future-stamped pass is too soon — clock skew never double-fires', () => {
    const d = decidePlannerAutorun(input({ health: okHealth(minutesAgo(-5)) }));
    expect(d).toMatchObject({ run: false, reason: 'too-soon', minutesSinceLastPass: -5 });
  });

  it('non-finite or negative numbers count as 0', () => {
    expect(decidePlannerAutorun(input({ phxReady: Number.NaN })))
      .toMatchObject({ run: true, phxReady: 0 });
    expect(decidePlannerAutorun(input({ phxReady: -7 }))).toMatchObject({ run: true, phxReady: 0 });
    // NaN running means the lane is treated as empty; negative target is none.
    const d = decidePlannerAutorun(input({
      lanes: [{ lane: 'a', running: Number.NaN, target: 2, held: false }, { lane: 'b', running: 0, target: -2, held: false }],
    }));
    expect(d.freeSlots).toBe(2);
    // Thresholds follow the same rule.
    expect(decidePlannerAutorun(input({ minGapMinutes: -1, health: okHealth(minutesAgo(0)) })).reason).toBe('low-supply');
    expect(decidePlannerAutorun(input({ lowSupply: Number.NaN })).reason).toBe('enough-supply');
  });

  it('an unreadable queue counts as 0 and says so in the detail', () => {
    const d = decidePlannerAutorun(input({ phxReady: 0, queueUnreadable: true }));
    expect(d).toMatchObject({ run: true, reason: 'low-supply' });
    expect(d.detail).toContain('unreadable');
    expect(d.detail).not.toMatch(/\//);
  });
});

describe('readPlannerAutorunInput', () => {
  const statusJson = () => JSON.stringify({
    last_tick: new Date(NOW).toISOString(),
    paused: false,
    mem_free_pct: 50,
    lanes: {
      'codex-personal': { running: 1, target: 3, queued: 0, floor: null, ceiling: null, held: false },
      devin: { running: 2, target: 2, queued: 0, floor: null, ceiling: null, held: false },
    },
  });
  const fixture = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'planner-autorun-'));
    await mkdir(join(dir, 'queue'), { recursive: true });
    return dir;
  };

  it('a missing queue counts as phxReady 0 with queueUnreadable — the tick still runs rather than starving', async () => {
    const dir = await fixture();
    try {
      const read = await readPlannerAutorunInput(dir, NOW);
      expect(read).toMatchObject({ phxReady: 0, queueUnreadable: true, orchOff: false, nowMs: NOW });
      // No status.json at all: no lane evidence means no provable free slot.
      expect(decidePlannerAutorun(read)).toMatchObject({ run: false, reason: 'no-free-slots' });
      // With lanes on disk but still no ready.tsv, the unreadable queue
      // counts as 0 and the pass runs — starving is worse than a wasted pass.
      await writeFile(join(dir, 'queue', 'status.json'), statusJson());
      const read2 = await readPlannerAutorunInput(dir, NOW);
      const d = decidePlannerAutorun(read2);
      expect(d).toMatchObject({ run: true, reason: 'low-supply', phxReady: 0 });
      expect(d.detail).toContain('unreadable');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reads the real files: supply from ready.tsv, slots from status.json, health from events', async () => {
    const dir = await fixture();
    try {
      await writeFile(join(dir, 'queue', 'ready.tsv'), [
        'RQ-PHX-A\tphantom\tcodex-personal\twork\t/q/p/a.md',
        'RQ-PHX-B\tphantom\tPARKED-BYHAND.codex-local\twork\t/q/p/b.md',
        'RQ-OTHR-C\tother\tdevin\twork\t/q/p/c.md',
      ].join('\n'));
      await writeFile(join(dir, 'queue', 'status.json'), statusJson());
      await writeFile(join(dir, 'queue', 'dispatch-events.log'), `${localStamp(NOW - 60 * 60_000)} LEADER cmp fixups=1\n`);
      const read = await readPlannerAutorunInput(dir, NOW);
      expect(read).toMatchObject({ phxReady: 1, orchOff: false });
      expect(read.lanes).toEqual([
        { lane: 'codex-personal', running: 1, target: 3, held: false },
        { lane: 'devin', running: 2, target: 2, held: false },
      ]);
      expect(read.health.status).toBe('ok');
      expect(decidePlannerAutorun(read)).toMatchObject({ run: true, reason: 'low-supply', freeSlots: 2 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('counts every real parked-row form as no supply and in-flight Phantom work as supply', async () => {
    const dir = await fixture();
    try {
      await writeFile(join(dir, 'queue', 'ready.tsv'), [
        'RQ-PHX-READY1\tphantom\tdevin\twork\t/q/p/1.md',                // ready, counts
        'RQ-PHX-PARKED2\tphantom\tPARKED-BYHAND.codex-local\twork\t/q/p/2.md', // parked: third column
        'status\tid\tlane',                                            // header switches the row shape
        'PARKED-HOLD.codex-personal\tRQ-PHX-PARKED3\tcodex-personal',    // parked: status column
        'READY\tRQ-PHX-READY4\tdevin',                                 // ready, counts
      ].join('\n'));
      const read = await readPlannerAutorunInput(dir, NOW);
      expect(read.phxReady).toBe(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('an ORCH_OFF file under the runs dir gates the pass, like planner-run checks', async () => {
    const dir = await fixture();
    try {
      await writeFile(join(dir, 'queue', 'status.json'), statusJson());
      await writeFile(join(dir, 'ORCH_OFF'), 'off\n');
      const read = await readPlannerAutorunInput(dir, NOW);
      expect(read.orchOff).toBe(true);
      expect(decidePlannerAutorun(read).reason).toBe('orch-off');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
