import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
// @ts-expect-error plain .mjs script with no declaration file
import * as perf from '../scripts/measure-desktop-perf.mjs';

const script = resolve('scripts/measure-desktop-perf.mjs');

describe('measure-desktop-perf statistics', () => {
  it('takes nearest-rank percentiles and null for no data', () => {
    expect(perf.percentile([], 50)).toBeNull();
    expect(perf.percentile([5], 95)).toBe(5);
    expect(perf.percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(perf.percentile([50, 10, 40, 20, 30], 95)).toBe(50);
    expect(perf.median([3, 1, 2])).toBe(2);
  });

  it('summarises frame intervals from rAF timestamps', () => {
    const s = perf.summarizeFrames([0, 16.7, 33.4, 100, 116.7]);
    expect(s.frames).toBe(4);
    expect(s.max).toBe(66.6);
    expect(s.over50ms).toBe(1);
    expect(s.p50).toBe(16.7);
    expect(perf.summarizeFrames([5])).toEqual({ frames: 0, p50: null, p95: null, max: null, over50ms: 0 });
  });

  it('summarises long tasks', () => {
    expect(perf.summarizeLongTasks([])).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
    expect(perf.summarizeLongTasks([{ startTime: 1, duration: 60 }, { startTime: 9, duration: 90.5 }])).toEqual({ count: 2, totalMs: 150.5, maxMs: 90.5 });
  });

  it('diffs CDP metric snapshots on shared keys only', () => {
    expect(perf.metricsDelta({ TaskDuration: 1, Nodes: 10 }, { TaskDuration: 1.5, Nodes: 12, Extra: 9 })).toEqual({ TaskDuration: 0.5, Nodes: 2 });
  });

  it('reduces runs to median headline numbers', () => {
    const run = (fmrMs: number, p95: number) => ({
      cold: { fmrMs, fcpMs: 100, longTasksBeforeFmr: 2, longTaskMsBeforeFmr: 120, apiRequestsBeforeFmr: 6, jsRequestsBeforeFmr: 30, jsBytesBeforeFmr: 2048 },
      warmup: { settledAfterMs: 5000, longTasks: 10, longTaskMs: 900, longTaskMaxMs: 200, resources: 40 },
      steady: { runningAnimations: { running: 0, top: [] }, frame: { p50: 16.7, p95, max: 40, over50ms: 0 }, longTasks: { count: 1, totalMs: 60, maxMs: 60 }, mainThreadBusyMsPerSec: 12, scriptMsPerSec: 8, layoutMsPerSec: 2, styleMsPerSec: 1, domNodes: 900, jsHeapMb: 20 },
    });
    const summary = perf.summarizeRuns([run(900, 17), run(700, 18), run(800, 40)]);
    expect(summary.coldStartMs.median).toBe(800);
    expect(summary.coldStartMs.min).toBe(700);
    expect(summary.coldStartMs.max).toBe(900);
    expect(summary.steady.frameP95Ms).toBe(18);
    expect(summary.jsKbBeforeFmr).toBe(2);
    expect(summary.warmup).toMatchObject({ settledAfterMs: 5000, longTasks: 10, longTaskMs: 900 });
  });
});

describe('measure-desktop-perf probe', () => {
  it('is syntactically valid page script that injects the host tokens and the target section', () => {
    const src = perf.probeSource('command', { readToken: 'r'.repeat(8), token: null });
    expect(() => new Function(src)).not.toThrow();
    expect(src).toContain('window.__ASHLR_TOKENS__ = {"readToken":"rrrrrrrr","token":null}');
    expect(src).toContain('main#main-content[data-section="');
    expect(src).toContain('"command"');
  });
});

describe('measure-desktop-perf CLI', () => {
  it('rejects unknown arguments without touching anything', () => {
    const r = spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown argument');
  });

  it('prints usage for --help', () => {
    const r = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('first meaningful render');
  });
});
