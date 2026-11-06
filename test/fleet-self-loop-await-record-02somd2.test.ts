import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetSelfLoopAwait } from '../src/cli/fleet-self-loop-await.js';

const AFTER = '2026-01-01T00:00:00.000Z';
const summary = { v: 1, startedAt: '2026-01-01T00:00:01.000Z', endedAt: '2026-01-01T00:00:03.000Z', elapsedMs: 2000, durationMs: 5000, intervalMs: 1000, ticks: 2, failures: 0, busy: 0, termination: 'max-ticks', maxTicks: 2, lastReport: { secret: 'RAW-REPORT' } };
const record = (over: Record<string, unknown> = {}, sum: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, startedAt: '2026-01-01T00:00:01.000Z', finishedAt: '2026-01-01T00:00:03.000Z', summary: { ...summary, ...sum }, ...over });
const setup = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'loop-await-'))); return { dir, file: join(dir, 'result.json') }; };
const argv = (file: string, extra: string[] = []) => ['--result-file', file, '--after', AFTER, '--timeout-ms', '500', '--poll-ms', '10', '--json', ...extra];
async function run(args: string[], deps: Parameters<typeof cmdFleetSelfLoopAwait>[1] = {}) {
  const out: string[] = [];
  const code = await cmdFleetSelfLoopAwait(args, { output: x => out.push(x), ...deps });
  return { code, out, json: JSON.parse(out[0]!) };
}

describe('fleet self-loop-await', () => {
  it('waits for a receipt written after polling starts and omits lastReport', async () => {
    const { dir, file } = setup();
    try {
      let sleeps = 0;
      const { code, out, json } = await run(argv(file), {
        sleep: async () => { if (++sleeps === 2) writeFileSync(file, record()); },
      });
      expect(code).toBe(0);
      expect(sleeps).toBe(2);
      expect(json).toMatchObject({ v: 1, ok: true, reason: 'completed', summary: { termination: 'max-ticks', maxTicks: 2, ticks: 2, failures: 0 } });
      expect(out[0]).not.toContain('RAW-REPORT');
      expect(json.summary.lastReport).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('never satisfies from a stale record, then accepts a fresh one', async () => {
    const { dir, file } = setup();
    try {
      writeFileSync(file, record({ startedAt: '2025-12-31T23:59:59.000Z', finishedAt: '2026-01-01T00:00:02.000Z' }));
      expect((await run(argv(file))).json).toMatchObject({ ok: false, reason: 'timed out' });
      let n = 0;
      const { code } = await run(argv(file), { sleep: async () => { if (++n === 1) writeFileSync(file, record()); } });
      expect(code).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('accepts duration and interrupted terminations', async () => {
    const { dir, file } = setup();
    try {
      for (const termination of ['duration', 'interrupted']) {
        writeFileSync(file, record({}, { termination, maxTicks: undefined }));
        expect((await run(argv(file))).json.summary.termination).toBe(termination);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses malformed, oversized, symlinked and non-regular receipts', async () => {
    const { dir, file } = setup();
    try {
      const bad = [record({ finishedAt: '2025-01-01T00:00:00.000Z' }), record({}, { ticks: -1 }), record({}, { termination: 'x' }),
        record({}, { elapsedMs: Number.POSITIVE_INFINITY }), record({ startedAt: 'yesterday' }), '{', '[]'];
      for (const text of bad) {
        writeFileSync(file, text);
        expect((await run(argv(file))).json).toMatchObject({ ok: false, reason: 'malformed record' });
      }
      writeFileSync(file, 'x'.repeat(65 * 1024));
      expect((await run(argv(file))).json.reason).toBe('oversized record');
      const real = join(dir, 'real.json'), link = join(dir, 'link.json');
      writeFileSync(real, record());
      symlinkSync(real, link);
      expect((await run(argv(link))).json).toMatchObject({ ok: false, reason: 'unsafe record' });
      expect((await run(argv(dir))).code).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('returns nonzero for failed or observer-error summaries', async () => {
    const { dir, file } = setup();
    try {
      for (const sum of [{ failures: 1 }, { termination: 'observer-error', maxTicks: undefined }]) {
        writeFileSync(file, record({}, sum));
        const { code, json } = await run(argv(file));
        expect(code).toBe(1);
        expect(json).toMatchObject({ ok: false, reason: 'loop failed' });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('times out on a missing receipt without polling past the deadline', async () => {
    const { dir, file } = setup();
    try {
      let clock = 0, reads = 0, maxReadAt = -1;
      const { code, json } = await run(argv(file, []).map(a => (a === '500' ? '100' : a)), {
        now: () => clock,
        sleep: async ms => { clock += ms; },
        read: async () => { reads++; maxReadAt = clock; return { kind: 'missing' }; },
      });
      expect(code).toBe(1);
      expect(json).toMatchObject({ ok: false, reason: 'timed out' });
      expect(reads).toBe(10);
      expect(maxReadAt).toBeLessThan(100);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects invalid arguments before any read', async () => {
    const { file } = setup();
    let reads = 0;
    const read = async () => { reads++; return { kind: 'missing' as const }; };
    const cases = [[], argv('relative.json'), argv(file).slice(0, -1), argv(file, ['--bogus']),
      ['--result-file', file, '--after', 'x', '--timeout-ms', '5', '--json'],
      ['--result-file', file, '--after', AFTER, '--timeout-ms', '0', '--json'],
      ['--result-file', file, '--after', AFTER, '--timeout-ms', '60001', '--json'],
      ['--result-file', file, '--after', AFTER, '--timeout-ms', '5', '--poll-ms', '9', '--json'],
      ['--result-file', file, '--after', AFTER, '--timeout-ms', '5', '--poll-ms', '1001', '--json'],
      argv(file, ['--json'])];
    for (const args of cases) {
      const { code, json } = await run(args, { read, sleep: async () => {} });
      expect(code).toBe(2);
      expect(json.reason).toBe('invalid arguments');
    }
    expect(reads).toBe(0);
  });
});
