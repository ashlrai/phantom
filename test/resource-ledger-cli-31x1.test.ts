import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdResourceLedger } from '../src/cli/resource-ledger.js';
import { cmdResources } from '../src/cli/resources.js';
import * as ledgerReader from '../src/core/fleet/runs-resource-ledger.js';
import { readResourceLedger, type ResourceLaneRow, type ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const row = (lane: string, fields: Partial<ResourceLaneRow>): ResourceLaneRow => ({
  lane, running: null, target: null, held: null, window: 'none', usedPct: null,
  creditsRemaining: null, resetAt: null, burnPctPerHour: null, tokensPerHour6h: null,
  projectedExhaustion: null, source: null, ...fields,
});
const ledger: ResourceLedgerV1 = {
  v: 1, generatedAt: '2026-10-31T12:01:00Z', asOf: '2026-10-31T12:00:00Z',
  sources: { status: 'degraded', apiSpend: 'missing' }, apiSpend: null,
  lanes: [
    row('claude', { running: 1, target: 2, held: true, window: 'weekly', usedPct: 0, resetAt: '2026-11-02T00:00:00Z', source: 'status' }),
    row('codex-personal', { window: 'weekly' }),
    row('api', { running: 0, target: 1, held: false, window: 'credits', creditsRemaining: 25 }),
    row('local', { running: 1, target: 1, held: false }),
  ],
};
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('phm resources ledger', () => {
  it('dispatches through resources and advertises the command', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResources(['ledger', '--help'])).toBe(0);
    expect(out.mock.calls.flat().join('\n')).toContain('phm resources ledger');
    out.mockClear();
    expect(await cmdResources(['--help'])).toBe(0);
    expect(out.mock.calls.flat().join('\n')).toContain('phm resources ledger');
  });

  it('emits exactly the injected ledger as one JSON document', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn().mockResolvedValue(ledger);
    expect(await cmdResourceLedger(['--json'], read)).toBe(0);
    expect(read).toHaveBeenCalledOnce();
    expect(out).toHaveBeenCalledOnce();
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual(ledger);
  });

  it('dispatches a ledger read through the resources command', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.spyOn(ledgerReader, 'readResourceLedger').mockResolvedValue(ledger);
    expect(await cmdResources(['ledger', '--json'])).toBe(0);
    expect(read).toHaveBeenCalledOnce();
    expect(out).toHaveBeenCalledOnce();
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual(ledger);
  });

  it('shows weekly, credit and local lanes, unknowns and source health', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourceLedger([], async () => ledger)).toBe(0);
    const text = out.mock.calls.flat().join('\n');
    expect(text).toContain('status degraded; API spend missing');
    expect(text).toContain('observed: 2026-10-31T12:00:00Z');
    expect(text).toContain('claude: running/target 1/2; held true; window weekly');
    expect(text).toContain('Weekly usage: 0%');
    expect(text).toContain('Reset: 2026-11-02T00:00:00Z; source: status');
    expect(text).toContain('codex-personal: running/target unknown/unknown; held unknown; window weekly');
    expect(text).toContain('Weekly usage: unknown');
    expect(text).toContain('api: running/target 0/1; held false; window credits');
    expect(text).toContain('Credits remaining: 25');
    expect(text).toContain('local: running/target 1/1; held false; window none');
    expect(text).toContain('Usage: unmetered / no reported window');
    expect(text).toContain('API spend: unknown');
    expect(text).not.toMatch(/5h|five.hour/i);
  });

  it('reports missing lanes and observed spend without fabricating values', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const empty: ResourceLedgerV1 = { ...ledger, asOf: null, lanes: [], sources: { status: 'missing', apiSpend: 'degraded' }, apiSpend: {
      rowsToday: 0, errorsToday: 0, tokensInToday: 0, tokensOutToday: 0, usdToday: null, usdWeek: 0, lastAt: null, models: [],
    } };
    expect(await cmdResourceLedger([], async () => empty)).toBe(0);
    const text = out.mock.calls.flat().join('\n');
    expect(text).toContain('observed: unknown');
    expect(text).toContain('status missing; API spend degraded');
    expect(text).toContain('Lanes: none reported');
    expect(text).toContain('today unknown USD; week 0 USD');
  });

  it.each([['--wat'], ['--json', '--json'], ['--help', '-h'], ['--help', '--bad'], ['extra']])('rejects invalid arguments %j before reading', async (...args) => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const read = vi.fn();
    expect(await cmdResourceLedger(args, read)).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([['--help'], ['-h'], ['--json', '--help']])('prints help without reading for %j', async (...args) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn();
    expect(await cmdResourceLedger(args, read)).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it('returns a static safe error on an unexpected reader failure', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdResourceLedger([], async () => { throw new Error('private details'); })).toBe(1);
    expect(err).toHaveBeenCalledExactlyOnceWith('Unable to read resource ledger.\n');
  });

  it('reads a temporary runs directory using the existing ledger reader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ledger-cli-'));
    roots.push(root);
    await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'queue/status.json'), JSON.stringify({
      last_tick: '2026-10-31T12:00:00Z', lanes: { claude: { running: 1, target: 3, held: false } },
      budget: { claude: { weekly_used_pct: 42 } },
    }));
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = () => readResourceLedger({ runsDir: root, now: () => Date.parse('2026-10-31T12:01:00Z') });
    expect(await cmdResourceLedger(['--json'], read)).toBe(0);
    const result = JSON.parse(String(out.mock.calls[0]![0]));
    expect(result).toEqual(await read());
    expect(result).toMatchObject({ sources: { status: 'healthy', apiSpend: 'missing' }, lanes: [{ lane: 'claude', window: 'weekly', usedPct: 42 }] });
  });
});
