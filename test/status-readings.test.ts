import { chmodSync, mkdtempSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseClaudeUsage, statusReaders, STATUS_READER_POOLS } from '../src/core/fabric/status-readings.js';
import { writeUsageSignal } from '../src/core/fabric/usage-signal-writer.js';
import { usageReadingV1Schema } from '../src/core/usage/usage-reading.js';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const future = Math.floor(NOW.getTime() / 1000) + 3600;
const SECRET = 'sk-TEST-SHOULD-NEVER-APPEAR';
let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-status-readings-'))); chmodSync(dir, 0o700); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseClaudeUsage fixtures', () => {
  const at = NOW.getTime();
  it('converts a 0..1 utilization with a live reset to a percent', () => {
    expect(parseClaudeUsage({ utilization: 0.427, resetsAt: future }, at))
      .toEqual({ pctUsed: 42.7, resetAt: new Date(future * 1000).toISOString() });
  });
  it.each([
    ['null event', null], ['percent-looking value', { utilization: 42, resetsAt: future }],
    ['negative', { utilization: -0.1, resetsAt: future }], ['expired', { utilization: 0.5, resetsAt: 1 }],
    ['string', { utilization: '0.5', resetsAt: future }], ['NaN', { utilization: NaN, resetsAt: future }],
    ['fractional reset', { utilization: 0.5, resetsAt: future + 0.5 }],
  ])('yields unknown for %s', (_name, event) => {
    expect(parseClaudeUsage(event, at)).toEqual({ pctUsed: null, resetAt: null });
  });
});

describe('statusReaders', () => {
  it('covers only the two documented pools and emits numeric fields only', async () => {
    expect(STATUS_READER_POOLS).toEqual(['codex-cmp', 'claude-max']);
    const readers = statusReaders({
      now: () => NOW, codexHome: '/pool/home',
      readCodex: async home => { expect(home).toBe('/pool/home'); return { pctUsed: 12, resetAt: '2026-11-02T15:00:00.000Z', raw: SECRET } as never; },
      readClaudeEvent: () => ({ utilization: 0.5, resetsAt: future, status: SECRET } as never),
    });
    expect(Object.keys(readers)).toEqual(['codex-cmp', 'claude-max']);
    const out = [await readers['codex-cmp'](), await readers['claude-max']()];
    expect(JSON.stringify(out)).not.toContain(SECRET);
    for (const row of out) expect(usageReadingV1Schema.safeParse(row).success).toBe(true);
  });
});

describe('dry-run and append through the journal writer', () => {
  const run = (dryRun: boolean) => writeUsageSignal({
    directory: dir, event: 'manual-reading', dryRun, now: () => NOW, pools: [...STATUS_READER_POOLS],
    readers: statusReaders({ now: () => NOW,
      readCodex: async () => ({ pctUsed: 30, resetAt: '2026-11-02T15:00:00.000Z' }),
      readClaudeEvent: () => ({ utilization: 0.25, resetsAt: future } as never) }),
  });
  it('dry run previews rows and writes no journal or snapshot', async () => {
    const result = await run(true);
    expect(result.preview?.map(r => [r.pool, r.pctUsed])).toEqual([['codex-cmp', 30], ['claude-max', 25]]);
    expect(existsSync(join(dir, 'usage-readings.log'))).toBe(false);
    expect(existsSync(join(dir, 'fleet.json'))).toBe(false);
  });
  it('a real run appends the same numeric rows, one JSON line each', async () => {
    const result = await run(false);
    expect(result.preview).toBeUndefined();
    const lines = readFileSync(join(dir, 'usage-readings.log'), 'utf8').trimEnd().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => [l.pool, l.pctUsed, l.source])).toEqual([['codex-cmp', 30, 'codex-cmp-reader'], ['claude-max', 25, 'claude-max-reader']]);
    for (const l of lines) expect(usageReadingV1Schema.safeParse(l).success).toBe(true);
  });
  it('unreadable sources log null, not zero', async () => {
    await writeUsageSignal({ directory: dir, event: 'manual-reading', now: () => NOW, pools: ['codex-cmp'],
      readers: statusReaders({ now: () => NOW, readCodex: async () => { throw new Error(SECRET); } }) });
    const row = JSON.parse(readFileSync(join(dir, 'usage-readings.log'), 'utf8'));
    expect(row.pctUsed).toBeNull();
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });
});

describe('usage-signal CLI flags', () => {
  it('rejects status-reader flag combinations that could smuggle other commands', async () => {
    const { runUsageSignal } = await import('../src/cli/usage-signal.js');
    await expect(runUsageSignal(['--directory', dir, '--event', 'manual-reading', '--codex-home', '/x'])).rejects.toThrow();
    await expect(runUsageSignal(['--directory', dir, '--event', 'manual-reading', '--status-readers',
      '--readers', join(dir, 'r.json')])).rejects.toThrow();
  });
});
