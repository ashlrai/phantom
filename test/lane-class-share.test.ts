import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyLaneJob, laneClassShare } from '../src/core/fleet/lane-class-share.js';
import { cmdFleetClassShare } from '../src/cli/fleet-class-share.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const row = (job: string, event: string, extra = {}) => ({ job, event, ts: '2026-10-31T11:00:00Z', lane: 'codex-personal', ...extra });
afterEach(() => vi.restoreAllMocks());

describe('lane class share', () => {
  it('classifies bounded identifiers including generated filler', () => {
    expect(['RQ-PHX-LANECLASSSHARE31', 'RQ-FIXUP-123Q8', 'RQ-PHX2A20261031Q8', 'RQ-STACK12A20261031Q8', 'RQ-unknown', 'RQ-STACK12A20261031Q8-retry'].map(classifyLaneJob))
      .toEqual(['phx', 'fixup', 'filler', 'filler', 'other', 'other']);
  });

  it('reports every class, missing finishes, per-lane totals and unique PRs', () => {
    const ids = ['RQ-PHX-test', 'RQ-FIXUP-1Q8', 'RQ-PHX2A20261031Q8', 'manual'];
    const rows = ids.flatMap((id, i) => [row(id, 'launch'), ...(i === 3 ? [] : [row(id, 'finish', { tokens_total: (i + 1) * 10 })])]);
    rows.push(row(ids[0]!, 'outcome', { lane: undefined, state: 'OPEN', url: 'https://github.com/ashlrai/phantom/pull/1' }),
      row(ids[0]!, 'outcome', { state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/1' }),
      row(ids[0]!, 'outcome', { state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/1' }),
      row(ids[0]!, 'launch'), row(ids[0]!, 'finish', { tokens_total: 10 }),
      row('RQ-PHX-second', 'launch', { lane: 'claude' }));
    const report = laneClassShare(rows, 3, now);
    expect(report.rows).toContainEqual({ lane: 'codex-personal', class: 'phx', launches: 1, tokens_total: 10, prs_opened: 1, prs_merged: 1 });
    expect(report.rows).toContainEqual({ lane: 'codex-personal', class: 'other', launches: 1, tokens_total: 0, prs_opened: 0, prs_merged: 0 });
    expect(report.rows.find(r => r.class === 'filler')?.tokens_total).toBe(30);
    expect(report.rows.find(r => r.class === 'fixup')?.tokens_total).toBe(20);
    expect(report.rows.find(r => r.lane === 'claude')?.launches).toBe(1);
  });

  it('ignores malformed lines, invalid totals and PR URLs, and excludes old/future events', () => {
    const text = ['broken', 'null', '[]', '{}', JSON.stringify(row('old', 'launch', { ts: '2026-10-30T00:00:00Z' })),
      JSON.stringify(row('future', 'launch', { ts: '2026-11-01T00:00:00Z' })),
      JSON.stringify(row('manual', 'launch')), JSON.stringify(row('manual', 'finish', { tokens_total: -1 })),
      JSON.stringify(row('manual', 'outcome', { state: 'MERGED', url: 'https://example.com/pull/1' })), ''].join('\n');
    expect(laneClassShare(text, 3, now)).toMatchObject({ malformed: 4, rows: [{ launches: 1, tokens_total: 0, prs_merged: 0 }] });
  });

  it('uses an old launch lane for a finish in the window, regardless of input order', () => {
    const report = laneClassShare([row('manual', 'finish', { lane: undefined, tokens_total: 5 }), row('manual', 'launch', { ts: '2026-10-30T00:00:00Z' })], 3, now);
    expect(report.rows[0]).toMatchObject({ launches: 0, tokens_total: 5 });
  });

  it('exposes JSON and validates CLI arguments before reading', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn(async () => JSON.stringify(row('RQ-PHX-test', 'launch')));
    expect(await cmdFleetClassShare(['--hours', '3', '--json'], read, now)).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ hours: 3, rows: [{ class: 'phx', launches: 1 }] });
    read.mockClear();
    for (const args of [['--hours', '0'], ['--hours'], ['--wat'], ['--json', '--json']]) expect(await cmdFleetClassShare(args, read, now)).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });

  it('reports unavailable metrics without leaking the source error', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetClassShare([], async () => { throw new Error('private path'); }, now)).toBe(1);
    expect(output).toHaveBeenCalledWith('fleet class-share: metrics unavailable');
  });
});
