import { expect, it } from 'vitest';
import { inflightBriefLines } from '../src/core/fleet/planner-inflight.js';
import type { IngestedRow } from '../src/core/fleet/drop-job-fate.js';

const NOW = Date.parse('2026-11-02T12:00:00');
/** Ledger `at` is local `YYYY-MM-DD HH:MM:SS`; derive it from NOW so no case rides a DST boundary. */
const atAgo = (hoursAgo: number): string => {
  const d = new Date(NOW - hoursAgo * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const row = (id: string, at: string, lane = 'claude', tier = 'work', title = `${id} title`): IngestedRow =>
  ({ at, id, pass: 'p1', lane, tier, title });

it('excludes a job whose id already has a bridge(<id>) merge', () => {
  const rows = [row('RQ-PHX-MERGED06', atAgo(2))];
  expect(inflightBriefLines(rows, ['bridge(RQ-PHX-MERGED06): merged title (#1)'], NOW))
    .toEqual(['(none: every job ingested in the last 48h has merged)']);
});

it('does not treat a longer id merge as covering a prefix id', () => {
  const rows = [row('RQ-PHX-A', atAgo(2))];
  const out = inflightBriefLines(rows, ['bridge(RQ-PHX-AB): other topic (#2)'], NOW);
  expect(out).toHaveLength(1);
  expect(out[0]).toBe('RQ-PHX-A claude work 2h RQ-PHX-A title');
});

it('excludes jobs ingested outside the window and keeps the boundary', () => {
  const rows = [row('RQ-PHX-STALE06', atAgo(49))];
  expect(inflightBriefLines(rows, [], NOW)).toEqual(['(none: every job ingested in the last 48h has merged)']);
  const edge = inflightBriefLines([row('RQ-PHX-EDGE06', atAgo(48))], [], NOW);
  expect(edge[0]).toBe('RQ-PHX-EDGE06 claude work 48h RQ-PHX-EDGE06 title');
});

it('deduplicates by id keeping the newest row, newest first', () => {
  const rows = [
    row('RQ-PHX-DUP06', atAgo(4), 'old', 'fast', 'stale ingest'),
    row('RQ-PHX-OLDER06', atAgo(5)),
    row('RQ-PHX-DUP06', atAgo(1), 'new', 'mid', 'fresh ingest'),
  ];
  const out = inflightBriefLines(rows, [], NOW);
  expect(out).toHaveLength(2);
  expect(out[0]).toBe('RQ-PHX-DUP06 new mid 1h fresh ingest');
  expect(out[1]).toMatch(/^RQ-PHX-OLDER06 /);
});

it('renders minute ages below one hour and dashes for empty lane and tier', () => {
  const out = inflightBriefLines([row('RQ-PHX-MIN06', atAgo(0.5), '', '')], [], NOW);
  expect(out[0]).toBe('RQ-PHX-MIN06 - - 30m RQ-PHX-MIN06 title');
});

it('caps at 80 rows and reports the hidden remainder', () => {
  const rows = Array.from({ length: 85 }, (_, i) => row(`RQ-PHX-CAP${String(i).padStart(3, '0')}`, atAgo(i / 60)));
  const out = inflightBriefLines(rows, [], NOW);
  expect(out).toHaveLength(81);
  expect(out[80]).toBe('(5 more in flight not shown)');
  expect(out[0]).toMatch(/^RQ-PHX-CAP000 /);
});

it('returns the none line for an empty ledger window', () => {
  expect(inflightBriefLines([], ['bridge(RQ-PHX-X): t'], NOW))
    .toEqual(['(none: every job ingested in the last 48h has merged)']);
});

it('strips control characters from cells and cuts titles to 80 characters', () => {
  const rows = [row('RQ-PHX-CTRL06', atAgo(1), 'la\x07ne', 'work', `pre\x00fix${'t'.repeat(100)}\x1f`)];
  const out = inflightBriefLines(rows, [], NOW);
  expect(out).toHaveLength(1);
  // eslint-disable-next-line no-control-regex -- asserting every control range is gone.
  expect(out[0]).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  expect(out[0]).toBe(`RQ-PHX-CTRL06 lane work 1h prefix${'t'.repeat(74)}`);
});

it('honours a caller-chosen window', () => {
  const rows = [row('RQ-PHX-WIN06', atAgo(6))];
  expect(inflightBriefLines(rows, [], NOW, 5)).toEqual(['(none: every job ingested in the last 5h has merged)']);
  expect(inflightBriefLines(rows, [], NOW, 6)[0]).toMatch(/^RQ-PHX-WIN06 /);
});
