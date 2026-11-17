import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdLanes } from '../src/cli/lanes.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function homeWith(files: Record<string, string>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'recut-c474-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, '.ashlr-runs', rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  vi.stubEnv('HOME', root);
}

const baseStatus = {
  last_tick: '2026-11-16T12:00:00Z',
  paused: null,
  mem_free_pct: 55,
  schema: 'dispatchd.status.v1',
  lanes: {} as Record<string, unknown>,
};

async function lanesJson(): Promise<Record<string, unknown>> {
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdLanes(['--json'])).toBe(0);
  return JSON.parse(out.mock.calls[0]![0]) as Record<string, unknown>;
}

const byLane = (report: Record<string, unknown>) =>
  Object.fromEntries((report.lanes as Array<{ lane: string }>).map(l => [l.lane, l]));

describe('RQ-PHX-RECUTTESTONLYC474: lanes --json measured-vs-unmeasured honesty', () => {
  it('carries rollup_24h merged and merge_rate verbatim for measured lanes only', async () => {
    await homeWith({ 'queue/status.json': JSON.stringify({ ...baseStatus,
      lanes: {
        'c474-measured': { running: 1, target: 2, queued: 0, held: false },
        'c474-norollup': { running: 0, target: 1, queued: 0, held: false },
      },
      rollup_24h: { by_lane: { 'c474-measured': { merged: 3, merge_rate: 0.75 } } },
    }) });
    const report = await lanesJson();
    expect(report.sourceState).toBe('healthy');
    const lanes = byLane(report);
    expect(lanes['c474-measured']).toMatchObject({ merged24h: 3, mergeRate24h: 0.75 });
    expect(lanes['c474-norollup']).toMatchObject({ merged24h: null, mergeRate24h: null });
  });

  it('measures tokensLastHour from jobs.jsonl and keeps measured-zero distinct from unmeasured', async () => {
    const ts = new Date().toISOString();
    await homeWith({
      'queue/status.json': JSON.stringify({ ...baseStatus, lanes: {
        'c474-active': { running: 1, target: 2, queued: 0, held: false },
        'c474-idle': { running: 0, target: 1, queued: 0, held: false },
      } }),
      'metrics/jobs.jsonl': [
        JSON.stringify({ event: 'finish', job: 'RQ-C474-TESTONLY-1', lane: 'c474-active', tokens_total: 1234, ts }),
        JSON.stringify({ event: 'finish', job: 'RQ-C474-TESTONLY-2', lane: 'c474-active', tokens_total: 66, ts }),
        '',
      ].join('\n'),
    });
    const report = await lanesJson();
    const lanes = byLane(report);
    expect(lanes['c474-active'].tokensLastHour).toBe(1300);
    // Metrics parsed cleanly: a lane with no finish rows is a measured 0, not unknown.
    expect(lanes['c474-idle'].tokensLastHour).toBe(0);
  });

  it('skips dispatcher global slot keys without degrading the status source', async () => {
    await homeWith({ 'queue/status.json': JSON.stringify({ ...baseStatus, lanes: {
      'hard_cap': { running: 9, target: 9, queued: 9, held: true },
      'c474-real': { running: 1, target: 1, queued: 0, held: false },
    } }) });
    const report = await lanesJson();
    expect(report.sourceState).toBe('healthy');
    expect(byLane(report)).not.toHaveProperty('hard_cap');
    expect(byLane(report)['c474-real']).toMatchObject({ running: 1, target: 1 });
  });

  it('degrades the status source honestly when one lane row fails validation', async () => {
    await homeWith({ 'queue/status.json': JSON.stringify({ ...baseStatus, lanes: {
      'c474-bad': { running: 'many', target: 1, queued: 0, held: false },
      'c474-good': { running: 1, target: 1, queued: 0, held: false },
    } }) });
    const report = await lanesJson();
    expect(report.sourceState).toBe('degraded');
    const lanes = byLane(report);
    expect(lanes).not.toHaveProperty('c474-bad');
    expect(lanes['c474-good']).toMatchObject({ running: 1, target: 1 });
  });
});
