import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePauseFile, pauseLine, readPauseState } from '../src/core/fleet/pause-state.js';
import { readFleetMemory } from '../src/core/fleet/memory-state.js';
import { readLanePressure } from '../src/core/fleet/lane-memory-pressure.js';

describe('pause state reader', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pause-state-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('no files: off and off, no line', async () => {
    const p = await readPauseState({}, dir);
    expect(p.global).toEqual({ state: 'off', since: null, reasons: [] });
    expect(p.local).toEqual({ state: 'off', since: null, reasons: [] });
    expect(pauseLine(p)).toBeNull();
  });

  it('PAUSE_LOCAL only: local on, cloud lanes running', async () => {
    await writeFile(join(dir, 'PAUSE_LOCAL'), '2026-11-21T05:50:00Z memory level 1\n');
    const p = await readPauseState({}, dir);
    expect(p.global.state).toBe('off');
    expect(p.local).toEqual({ state: 'on', since: '2026-11-21T05:50:00.000Z', reasons: ['memory level 1'] });
    expect(pauseLine(p)).toBe('Local models paused, cloud lanes running: memory level 1');
  });

  it('PAUSE only: global on', async () => {
    await writeFile(join(dir, 'PAUSE'), '2026-11-21 00:50:00 free memory low; swap growing');
    const p = await readPauseState({}, dir);
    expect(p.local.state).toBe('off');
    expect(p.global.state).toBe('on');
    expect(p.global.reasons).toEqual(['free memory low', 'swap growing']);
    expect(pauseLine(p)).toBe('All launches paused: free memory low; swap growing');
  });

  it('both: both on, the all-launches line wins', async () => {
    await writeFile(join(dir, 'PAUSE'), '1795241000 disk full');
    await writeFile(join(dir, 'PAUSE_LOCAL'), '1795241000 memory level 1');
    const p = await readPauseState({}, dir);
    expect([p.global.state, p.local.state]).toEqual(['on', 'on']);
    expect(p.global.since).toBe(new Date(1795241000 * 1000).toISOString());
    expect(pauseLine(p)).toBe('All launches paused: disk full');
  });

  it('unreadable is unknown, never off', async () => {
    await mkdir(join(dir, 'PAUSE'));
    const p = await readPauseState({}, dir);
    expect(p.global.state).toBe('unknown');
    expect(p.local.state).toBe('off');
    expect(pauseLine(p)).toMatch(/could not be read/);
    await mkdir(join(dir, 'PAUSE_LOCAL'));
    expect((await readPauseState({}, dir)).local.state).toBe('unknown');
  });

  it('a file without a timestamp keeps the whole line as the reason; an empty file is still on', () => {
    expect(parsePauseFile('memory held')).toEqual({ state: 'on', since: null, reasons: ['memory held'] });
    expect(parsePauseFile('')).toEqual({ state: 'on', since: null, reasons: [] });
  });

  it('fleet memory card and lane pressure use the same reader', async () => {
    await writeFile(join(dir, 'PAUSE_LOCAL'), 'memory level 1');
    const mem = await readFleetMemory({ pausePath: join(dir, 'PAUSE'), metricsPath: join(dir, 'm.json'), admissionPath: join(dir, 'a.json') });
    expect(mem.pause.state).toBe('absent');
    expect(mem.pauseState.local.state).toBe('on');
    const report = await readLanePressure({ runsDir: dir });
    expect(report.pauseLine).toBe('Local models paused, cloud lanes running: memory level 1');
  });
});
