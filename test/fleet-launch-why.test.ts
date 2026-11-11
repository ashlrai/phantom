import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DISK_HARD_STOP_GB_DEFAULT, DISK_REUSE_ONLY_GB_DEFAULT, explainLaunchBlock, parseAdmissionSnapshot,
  readLaunchWhyInput, statfsFreeGb, thresholdFromEnv, type LaunchAdmissionSnapshot, type LaunchWhyInput,
} from '../src/core/fleet/launch-why.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const snap = (over: Partial<LaunchAdmissionSnapshot> = {}): LaunchAdmissionSnapshot => ({
  ts: '2026-11-09T11:59:00Z', admit: true, reason: null, gateReason: null, disabled: false,
  cap: 18, running: 4, diskFreeGb: 500, diskHardStopGb: 30, ...over,
});
const input = (over: Partial<LaunchWhyInput> = {}): LaunchWhyInput => ({
  admission: snap(), diskFreeGb: 500, reuseOnlyGb: 100, hardStopGb: 30, diskguardMarkers: 0, now: NOW, ...over,
});
const LOADGATE_OFF = 'Load gate is switched off (LOADGATE_OFF); launches are not blocked by load.';

describe('explainLaunchBlock', () => {
  it('disk reuse-only names free space, the guard and waiting jobs', () => {
    expect(explainLaunchBlock(input({ diskFreeGb: 41.7, diskguardMarkers: 2 }))).toEqual({
      code: 'disk-reuse-only', detail: [],
      line: 'Only repair jobs can start: 41 GB free on the runs disk, under the 100 GB guard. 2 jobs are waiting for disk.',
    });
    expect(explainLaunchBlock(input({ diskFreeGb: 99.6, diskguardMarkers: null })).line)
      .toBe('Only repair jobs can start: 99 GB free on the runs disk, under the 100 GB guard. Jobs waiting for disk: unknown.');
  });

  it('disk hard stop', () => {
    expect(explainLaunchBlock(input({ diskFreeGb: 25 }))).toMatchObject({
      code: 'disk-hard-stop', line: 'Nothing can start: 25 GB free on the runs disk, under the 30 GB hard stop.',
    });
  });

  it('load gate, at cap and stale dispatcher', () => {
    expect(explainLaunchBlock(input({ admission: snap({ admit: false, gateReason: 'loadavg 80.0 > 36.0' }) })))
      .toMatchObject({ code: 'load-gate', line: 'The load gate stopped launches: loadavg 80.0 > 36.0.' });
    expect(explainLaunchBlock(input({ admission: snap({ admit: false, running: 18 }) })))
      .toMatchObject({ code: 'at-cap', line: 'All 18 slots are in use.' });
    expect(explainLaunchBlock(input({ admission: snap({ ts: '2026-11-09T11:38:00Z' }) })))
      .toMatchObject({ code: 'dispatcher-stale', line: 'The dispatcher has not ticked for 22 min.' });
    expect(explainLaunchBlock(input({ admission: snap({ ts: null }) })).code).toBe('dispatcher-stale');
  });

  it('priority: hard stop beats reuse-only beats load gate beats cap beats stale', () => {
    const tripped = snap({ admit: false, gateReason: 'memory_pressure 4 >= 4', running: 18 });
    expect(explainLaunchBlock(input({ admission: tripped, diskFreeGb: 10, reuseOnlyGb: 100 })).code).toBe('disk-hard-stop');
    expect(explainLaunchBlock(input({ admission: tripped, diskFreeGb: 50 })).code).toBe('disk-reuse-only');
    expect(explainLaunchBlock(input({ admission: tripped })).code).toBe('load-gate');
    expect(explainLaunchBlock(input({ admission: { ...tripped, gateReason: null } })).code).toBe('at-cap');
  });

  it('a stale snapshot is not trusted for gate or cap', () => {
    const old = snap({ ts: '2026-11-09T10:00:00Z', admit: false, gateReason: 'loadavg 80.0 > 36.0', disabled: true });
    expect(explainLaunchBlock(input({ admission: old }))).toEqual({
      code: 'dispatcher-stale', line: 'The dispatcher has not ticked for 120 min.', detail: [],
    });
  });

  it('disabled alone is never a block, and never worded as dispatch being off', () => {
    const why = explainLaunchBlock(input({ admission: snap({ disabled: true }) }));
    expect(why).toEqual({ code: 'none', line: 'Nothing is blocking launches.', detail: [LOADGATE_OFF] });
    expect(JSON.stringify(why)).not.toMatch(/dispatch(ing)? (is )?(off|disabled)/i);
  });

  it('unreadable disk stays unknown and never becomes zero', () => {
    const why = explainLaunchBlock(input({ diskFreeGb: null }));
    expect(why).toEqual({ code: 'none', line: 'Nothing is blocking launches.', detail: ['Free space on the runs disk: unknown.'] });
    expect(explainLaunchBlock(input({ diskFreeGb: null, diskguardMarkers: 3 }))).toMatchObject({
      code: 'unknown', line: '3 jobs are waiting for disk, but free space on the runs disk is unknown.',
    });
    expect(JSON.stringify(explainLaunchBlock(input({ diskFreeGb: null, diskguardMarkers: 3 })))).not.toMatch(/\b0 GB/);
  });

  it('an unclassified hold or unreadable snapshot is unknown', () => {
    expect(explainLaunchBlock(input({ admission: snap({ admit: false, reason: 'paused' }) })))
      .toMatchObject({ code: 'unknown', line: 'The dispatcher is holding launches: paused.' });
    expect(explainLaunchBlock(input({ admission: null, admissionUnreadable: true })).code).toBe('unknown');
    expect(explainLaunchBlock(input({ admission: null })).code).toBe('none');
  });
});

describe('parsing and thresholds', () => {
  it('keeps wrong-typed fields null', () => {
    expect(parseAdmissionSnapshot({ schema: 'other' })).toBeNull();
    expect(parseAdmissionSnapshot({ schema: 'dispatchd.admission.v2', cap: 'x', running: -1, disk_free_gb: 'big' }))
      .toMatchObject({ cap: null, running: null, diskFreeGb: null, admit: null, disabled: false });
  });

  it('mirrors dispatchd env parsing with its defaults', () => {
    expect(DISK_REUSE_ONLY_GB_DEFAULT).toBe(100);
    expect(DISK_HARD_STOP_GB_DEFAULT).toBe(30);
    expect(thresholdFromEnv({}, 'DISK_REUSE_ONLY_GB', 100)).toBe(100);
    expect(thresholdFromEnv({ DISK_REUSE_ONLY_GB: '60' }, 'DISK_REUSE_ONLY_GB', 100)).toBe(60);
    expect(thresholdFromEnv({ DISK_REUSE_ONLY_GB: 'lots' }, 'DISK_REUSE_ONLY_GB', 100)).toBe(100);
  });
});

describe('readLaunchWhyInput', () => {
  let runs: string;
  beforeEach(() => { runs = mkdtempSync(join(tmpdir(), 'launch-why-')); });
  afterEach(() => { rmSync(runs, { recursive: true, force: true }); });

  const writeAdmission = (body: Record<string, unknown>) => {
    mkdirSync(join(runs, 'queue'), { recursive: true });
    writeFileSync(join(runs, 'queue', 'admission.json'), JSON.stringify({ schema: 'dispatchd.admission.v2', ...body }));
  };

  it('counts diskguard markers and prefers the fresh snapshot disk reading', async () => {
    mkdirSync(join(runs, 'queue', 'run'), { recursive: true });
    for (const name of ['RQ-FAKE-A.diskguard', 'RQ-FAKE-B.diskguard', 'RQ-FAKE-C.line', 'RQ-FAKE-C.rc']) writeFileSync(join(runs, 'queue', 'run', name), '');
    writeAdmission({ ts: '2026-11-09T11:59:00Z', admit: true, disk_free_gb: 41.2, disk_hard_stop_gb: 20, cap: 18, running: 3 });
    const read = await readLaunchWhyInput(runs, { now: NOW, env: {}, freeGb: async () => { throw new Error('must not statfs'); } });
    expect(read).toMatchObject({ diskguardMarkers: 2, diskFreeGb: 41.2, hardStopGb: 20, reuseOnlyGb: 100, admissionUnreadable: false });
    expect(explainLaunchBlock(read).line).toBe('Only repair jobs can start: 41 GB free on the runs disk, under the 100 GB guard. 2 jobs are waiting for disk.');
  });

  it('falls back to statfs and env thresholds without a snapshot', async () => {
    const read = await readLaunchWhyInput(runs, { now: NOW, env: { DISK_REUSE_ONLY_GB: '60', DISK_HARD_STOP_GB: '10' }, freeGb: async () => 55 });
    expect(read).toMatchObject({ admission: null, admissionUnreadable: false, diskFreeGb: 55, reuseOnlyGb: 60, hardStopGb: 10, diskguardMarkers: null });
  });

  it('a stale snapshot reads dispatcher-stale and uses a live disk reading', async () => {
    writeAdmission({ ts: '2026-11-09T11:38:00Z', admit: true, disk_free_gb: 5 });
    const read = await readLaunchWhyInput(runs, { now: NOW, env: {}, freeGb: async () => 400 });
    expect(read.diskFreeGb).toBe(400);
    expect(explainLaunchBlock(read)).toMatchObject({ code: 'dispatcher-stale', line: 'The dispatcher has not ticked for 22 min.' });
  });

  it('unreadable disk and corrupt snapshot stay unknown', async () => {
    mkdirSync(join(runs, 'queue'), { recursive: true });
    writeFileSync(join(runs, 'queue', 'admission.json'), '{not json');
    const read = await readLaunchWhyInput(runs, { now: NOW, env: {}, freeGb: async () => { throw new Error('ENOSYS'); } });
    expect(read).toMatchObject({ admission: null, admissionUnreadable: true, diskFreeGb: null });
    expect(explainLaunchBlock(read)).toMatchObject({ code: 'unknown', detail: ['Free space on the runs disk: unknown.'] });
  });

  it('statfs gives a finite non-negative GB for a temp dir', async () => {
    const free = await statfsFreeGb(runs);
    expect(Number.isFinite(free) && free >= 0).toBe(true);
  });
});
