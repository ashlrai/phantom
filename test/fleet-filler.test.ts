import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetFiller, fleetFiller } from '../src/cli/fleet-filler.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-04T08:41:25Z');
const row = (event: string, patch: Record<string, unknown> = {}) => JSON.stringify({
  job: 'RQ-PS12A3Q8', ts: '2026-11-04T03:41:25-0500', event, ...patch,
});
afterEach(() => vi.restoreAllMocks());

describe('fleet filler', () => {
  it('counts events by prefix, skip code and strict empty/merged fields, most skips first', async () => {
    const read = vi.fn(async () => [
      row('launch'), row('launch'), row('precheck_skip', { code: 'dirty' }),
      row('precheck_skip', { code: 'dirty' }), row('precheck_skip', { code: 'busy' }),
      row('finish', { empty: true }), row('finish', { empty: 'true' }), row('finish', { empty: false }),
      row('outcome', { state: 'MERGED' }), row('outcome', { state: 'FAILED' }),
      ...['PLUGIN', 'STACK', 'LOCUS', 'LEXICON', 'MD'].map(prefix => row('launch', { job: `RQ-${prefix}1A22Q8` })),
    ]);
    const report = await fleetFiller(read, now);
    expect(read).toHaveBeenCalledExactlyOnceWith(3000);
    expect(report).toMatchObject({ known: true, readOnly: true, window_hours: 24 });
    expect(report.groups[0]).toEqual({ prefix: 'RQ-PS', launches: 2, skips: 3, skips_by_code: { dirty: 2, busy: 1 }, empty_finishes: 1, merged: 1 });
    expect(report.groups.slice(1).map(g => g.prefix)).toEqual(['RQ-LEXICON', 'RQ-LOCUS', 'RQ-MD', 'RQ-PLUGIN', 'RQ-STACK']);
  });

  it('filters malformed rows, exact job pattern, timestamps and the inclusive 24 hour window', async () => {
    const lines = ['broken', 'null', '[]', row('other'),
      ...['RQ-PS1A1Q8-extra', 'xRQ-PS1A1Q8', 'RQ-PS1Q8', 'RQ-OTHER1A1Q8'].map(job => row('launch', { job })),
      ...['invalid', '2026-11-03T08:41:24Z', '2026-11-04T08:41:26Z'].map(ts => row('launch', { ts })),
      row('launch', { ts: '2026-11-03T08:41:25Z' }), row('launch'),
    ];
    expect((await fleetFiller(async () => lines, now)).groups[0]!.launches).toBe(2);
    expect((await fleetFiller(async () => [row('launch'), ...Array<string>(3000).fill('broken')], now)).groups).toEqual([]);
  });

  it('prints JSON and one plain line per prefix without unrelated log data', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const read = async () => [row('precheck_skip', { code: 'busy', detail: 'private detail' })];
    expect((await FLEET_SUBCOMMAND_LOADERS.filler!()).cmdFleetFiller).toBe(cmdFleetFiller);
    expect(await cmdFleetFiller(['--json'], read, now)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0])).groups[0].skips_by_code).toEqual({ busy: 1 });
    expect(await cmdFleetFiller([], read, now)).toBe(0);
    expect(log.mock.calls[1]![0]).toBe('RQ-PS: 0 launches, 1 skips (busy=1), 0 empty finishes, 0 merged');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private detail');
  });

  it('handles absent metrics, empty input, unsafe codes and prototype keys', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetFiller(['--json'], async () => { throw new Error('private'); }, now)).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ known: false, groups: [] });
    expect(await cmdFleetFiller([], async () => [], now)).toBe(0);
    expect(log.mock.calls[1]![0]).toBe('No filler activity in the last 24 hours.');
    const report = await fleetFiller(async () => [row('precheck_skip', { code: '__proto__' }), row('precheck_skip', { code: 'private\n/path' }), row('precheck_skip')], now);
    expect(report.groups[0]!.skips_by_code).toEqual({ ['__proto__']: 1, unknown: 2 });
  });

  it('validates flags before reading and offers a single obvious command', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const read = vi.fn();
    for (const flag of ['--help', '-h']) expect(await cmdFleetFiller([flag], read, now)).toBe(0);
    for (const args of [['--other'], ['--json', '--json']]) expect(await cmdFleetFiller(args, read, now)).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });
});
