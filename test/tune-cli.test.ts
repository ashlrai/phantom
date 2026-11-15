import { afterEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ raw: '', files: new Map<string, string>(), scanFails: false }));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => 'trusted scanner'),
  mkdir: vi.fn(async () => undefined),
  open: vi.fn(async (path: string, flags: string) => {
    if (flags === 'wx' && io.files.has(path)) throw new Error('exists');
    return { stat: async () => ({ size: io.raw.length }), readFile: async () => io.raw,
      writeFile: async (s: string) => { io.files.set(path, s); }, close: async () => undefined };
  }),
}));
vi.mock('node:child_process', () => ({ execFile: vi.fn((_bin, _args, _opts, cb) => {
  queueMicrotask(() => cb(io.scanFails ? new Error('sensitive scanner diagnostic') : null));
  return { stdin: { on: vi.fn(), end: vi.fn() } };
}) }));
import { cmdTune } from '../src/cli/tune.js';
import { digest, sampleHash } from '../src/core/tune/dataset.js';
afterEach(() => { vi.restoreAllMocks(); io.files.clear(); io.scanFails = false; io.raw = ''; });
describe('tune CLI boundaries', () => {
  it('prints help and refuses unsupported training commands', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdTune(['--help'])).toBe(0); expect(log).toHaveBeenCalled();
    expect(await cmdTune(['train'])).toBe(2); expect(io.files.size).toBe(0);
  });
  it('writes only scrub-checked samples and refuses reuse', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    io.raw = Array.from({ length: 5 }, (_, i) => {
      const s = { jobId: `job-${i}`, task: `Fix case ${i}`, mergedDiff: `+return ${i};`,
        mergeSha: 'a'.repeat(40), mergedAt: `2026-01-0${i + 1}T00:00:00Z` };
      return JSON.stringify({ ...s, review: { model: 'claude', verdict: 'approve', critique: 'Fix is correct.', contentHash: sampleHash(s) } });
    }).join('\n');
    expect(await cmdTune(['prepare', 'input', 'output', 'scanner'])).toBe(0);
    expect(io.files.size).toBe(5);
    expect(await cmdTune(['prepare', 'input', 'output', 'scanner'])).toBe(1);
    io.files.clear(); io.scanFails = true;
    expect(await cmdTune(['prepare', 'input', 'output', 'scanner'])).toBe(1);
    expect(io.files.size).toBe(0); expect(JSON.stringify(err.mock.calls)).not.toContain('sensitive scanner diagnostic');
  });
  it('reports paired eligibility and rejects invalid measurements without printing input', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const baseline = Array.from({ length: 5 }, (_, i) => ({ taskId: digest(String(i)), passed: false, mergeGatePassed: true, latencyMs: 100, tokensPerSecond: 20 }));
    io.raw = JSON.stringify({ baseline, candidate: baseline.map(r => ({ ...r, passed: true })), heldoutIds: baseline.map(r => r.taskId) });
    expect(await cmdTune(['evaluate', 'report'])).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain('eligible-for-review');
    io.raw = '{private malformed input';
    expect(await cmdTune(['evaluate', 'report'])).toBe(1);
    expect(JSON.stringify(err.mock.calls)).not.toContain('private malformed input');
  });
});
