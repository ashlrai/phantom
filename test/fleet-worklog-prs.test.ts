import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdWorklog } from '../src/cli/worklog.js';
import { worklog } from '../src/core/fleet/worklog.js';
import { worklogPrs } from '../src/core/fleet/worklog-prs.js';

const NOW = Date.parse('2026-11-18T15:20:00Z');
const pull = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const LEDGER = [
  { event: 'launch', job: 'a', lane: 'work', model: 'glm', ts: '2026-11-18T14:00:00Z' },
  { event: 'publish', job: 'a', url: pull(7), title: 'Add the thing', ts: '2026-11-18T14:10:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'a', url: pull(7), ttm_s: 600, ts: '2026-11-18T14:20:00Z' },
  { event: 'publish', job: 'b', url: pull(9), ts: '2026-11-18T14:40:00Z' },
  { event: 'outcome', state: 'MERGED', job: 'b', url: pull(9), ts: '2026-11-18T15:05:00Z' },
  { event: 'launch', job: 'c', lane: 'fast', ts: '2026-11-18T14:30:00Z' },
  { event: 'finish', job: 'c', empty: true, ts: '2026-11-18T14:35:00Z' },
].map(row => JSON.stringify(row)).join('\n');
const base = () => worklog(LEDGER, NOW - 24 * 3600000, NOW, { hours: 24 });
afterEach(() => vi.restoreAllMocks());

describe('worklogPrs', () => {
  it('lists merged PRs newest first with lane and minutes, unknown as null, and counts no-PR jobs per hour', () => {
    const report = worklogPrs(base());
    expect(report.schema).toBe('fleet.worklog-prs.v1');
    expect(report.prs.map(pr => [pr.pr, pr.lane, pr.model, pr.minutes, pr.title])).toEqual([
      [9, null, null, null, null], [7, 'work', 'glm', 10, 'Add the thing'],
    ]);
    expect(report.merged).toBe(2);
    expect(report.noPr).toBe(1);
    expect(report.hourly.map(h => [h.hour, h.merged, h.noPr])).toEqual([['2026-11-18T15:00:00.000Z', 1, 0], ['2026-11-18T14:00:00.000Z', 1, 1]]);
    expect(worklogPrs(base(), 'other').prs).toEqual([]);
    expect(worklogPrs(base(), 'phantom').merged).toBe(2);
  });

  it('prints unknown for missing fields from the CLI and json for agents', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdWorklog(['--prs'], async () => base())).toBe(0);
    const text = String(out.mock.calls[0]![0]);
    expect(text).toContain('unknown lane · unknown model · unknown min to merge');
    expect(text).toContain('work · glm · 10 min to merge');
    expect(await cmdWorklog(['--prs', '--json', '--repo', 'ashlrai/phantom'], async () => base())).toBe(0);
    expect(JSON.parse(String(out.mock.calls[1]![0])).repo).toBe('ashlrai/phantom');
  });
});
