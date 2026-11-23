import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as queueSource from '../src/core/fleet/runs-parked-queue.js';
import * as mainHealth from '../src/core/fleet/main-health.js';
import * as journal from '../src/core/fleet/leader-journal.js';
import { readLeaderStatusSnapshot, renderLeaderStatus } from '../src/core/comms/leader-status-snapshot.js';

// Guardian headings use local wall time, like the production writer.
const now = Date.parse('2026-11-11T12:00:00');
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'leader-freshness-'));
  roots.push(root);
  for (const dir of ['queue', 'supervisor', 'leader']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'supervisor', 'status-main-guardian.md'), [
    '# Main guardian status (2026-11-11 12:00:00)',
    '| repo | branch | sha | state | checked | failing | fixes | nightly |',
    '| phantom | master | abcdef1 | green | 2026-11-11 12:00:00 | | | |',
  ].join('\n'));
  writeFileSync(join(root, 'leader', 'PLAN-LOG.md'), '## 2026-11-11 12:00\n**CEO summary**\n- Work continues.\n');
  return root;
}
function writeQueue(root: string, last_tick: unknown, merged = 12): void {
  writeFileSync(join(root, 'queue', 'status.json'), JSON.stringify({ last_tick, rollup_24h: { merged, median_ttm_s: 120, by_lane: { codex: { merged } } } }));
}
async function snapshot(root: string) { return readLeaderStatusSnapshot({ runsDir: root, now: () => now }); }

describe('Leader queue rollup freshness', () => {
  it.each([0, 60_000])('keeps totals at age %i ms', async age => {
    const root = fixture(); writeQueue(root, new Date(now - age).toISOString());
    const result = await snapshot(root);
    expect(result).toMatchObject({ merged24h: 12, medianTtmS: 120, lanes: [{ lane: 'codex', merged: 12 }] });
    expect(renderLeaderStatus(result)).toContain('last 24h: 12');
  });
  it('preserves an observed zero', async () => {
    const root = fixture(); writeQueue(root, new Date(now).toISOString(), 0);
    expect(renderLeaderStatus(await snapshot(root))).toContain('last 24h: 0');
  });
  it.each([new Date(now - 60_001).toISOString(), 'invalid', undefined, null, 123, new Date(now + 3_600_000).toISOString(), new Date(now + 1).toISOString()])('reports unknown for tick %s and preserves other sources', async tick => {
    const root = fixture(); writeQueue(root, tick);
    const result = await snapshot(root);
    expect(result).toMatchObject({ merged24h: null, medianTtmS: null, running: null, queued: null, lanes: [], mains: { known: true, green: 1 }, ceo: ['Work continues.'] });
    const reply = renderLeaderStatus(result);
    expect(reply).toContain('last 24h: unknown');
    expect(reply).not.toMatch(/last 24h: (?:0|12)\b/);
    expect(reply).toContain('Mains green: 1 of 1');
    expect(reply).toContain('CEO summary: Work continues.');
    expect(reply).not.toContain(root);
  });
  it('degrades unreadable queue and missing guardian independently', async () => {
    const root = fixture();
    writeFileSync(join(root, 'queue', 'status.json'), '{');
    rmSync(join(root, 'supervisor', 'status-main-guardian.md'));
    const result = await snapshot(root);
    expect(result.mains).toMatchObject({ known: false, green: null, red: null, total: null, observedAt: null });
    expect(renderLeaderStatus(result)).toContain('last 24h: unknown');
    expect(renderLeaderStatus(result)).toContain('Mains: unknown');
    expect(result.ceo).toEqual(['Work continues.']);
    expect(renderLeaderStatus(result)).not.toContain(root);
  });
  it('keeps fresh queue and guardian when the journal is missing', async () => {
    const root = fixture(); writeQueue(root, new Date(now).toISOString());
    rmSync(join(root, 'leader', 'PLAN-LOG.md'));
    expect(await snapshot(root)).toMatchObject({ merged24h: 12, mains: { known: true, green: 1 }, ceo: [] });
  });

  it('reports lane activity independently of merge evidence and preserves measured zeroes', async () => {
    const root = fixture();
    writeFileSync(join(root, 'queue', 'status.json'), JSON.stringify({ last_tick: new Date(now).toISOString(),
      lanes: { claude: { running: 2, queued: 5 }, codex: { running: 0, queued: 0 }, devin: { running: -1, queued: '3' } },
      rollup_24h: { merged: 3, by_lane: { claude: { merged: 3 } } } }));
    const result = await snapshot(root);
    expect(result).toMatchObject({ queueState: 'fresh', running: null, queued: null });
    expect(result.laneActivity).toEqual([
      { lane: 'claude', running: 2, queued: 5 }, { lane: 'codex', running: 0, queued: 0 },
      { lane: 'devin', running: null, queued: null },
    ]);
    expect(result.merged24h).toBe(3);
    expect(renderLeaderStatus(result)).toContain('claude: 2 running, 5 queued; codex: 0 running, 0 queued; devin: unknown running, unknown queued');
  });

  it.each([undefined, {}, { running: 1.5, queued: Number.MAX_SAFE_INTEGER + 1 }])('keeps missing or invalid activity unknown: %j', async activity => {
    const root = fixture();
    writeFileSync(join(root, 'queue', 'status.json'), JSON.stringify({ last_tick: new Date(now).toISOString(),
      lanes: { codex: activity }, rollup_24h: { by_lane: { codex: { merged: 4 } } } }));
    const result = await snapshot(root);
    expect(result.laneActivity).toEqual([{ lane: 'codex', running: null, queued: null }]);
    expect(result.merged24h).toBe(4);
  });

  it('keeps activity available when merge evidence is absent', async () => {
    const root = fixture();
    writeFileSync(join(root, 'queue', 'status.json'), JSON.stringify({ last_tick: new Date(now).toISOString(), lanes: { codex: { running: 1, queued: 2 } } }));
    const result = await snapshot(root);
    expect(result).toMatchObject({ merged24h: null, laneActivity: [{ lane: 'codex', running: 1, queued: 2 }] });
    expect(renderLeaderStatus(result)).toContain('codex: 1 running, 2 queued');
  });

  it.each(['missing', 'malformed', 'stale'])('does not expose cached activity when the queue is %s', async state => {
    const root = fixture();
    if (state !== 'missing') writeFileSync(join(root, 'queue', 'status.json'), state === 'malformed' ? '{' : JSON.stringify({
      last_tick: new Date(now - 60_001).toISOString(), lanes: { codex: { running: 8, queued: 9 } }, rollup_24h: { merged: 12 },
    }));
    const result = await snapshot(root);
    expect(result).toMatchObject({ queueState: state === 'stale' ? 'stale' : 'unavailable', laneActivity: [], merged24h: null, running: null, queued: null });
    expect(renderLeaderStatus(result)).toContain('Lane activity: unknown');
    expect(result.mains.known).toBe(true);
  });

  it.each(['2026-11-11 11:29:59', '2026-11-11 12:00:01', 'invalid'])('reports unknown guardian health for stale or undated input: %s', async at => {
    const root = fixture(); writeQueue(root, new Date(now).toISOString());
    writeFileSync(join(root, 'supervisor', 'status-main-guardian.md'), `# Main guardian status (${at})\n| phantom | master | abcdef1 | green | ${at} | | | |`);
    const result = await snapshot(root);
    expect(result.mains).toMatchObject({ guardianState: 'stale', known: false, stale: true, green: null, red: null, total: null, unknown: null });
    expect(renderLeaderStatus(result)).toContain('Mains: unknown');
    expect(renderLeaderStatus(result)).not.toContain('Mains green:');
    expect(result.merged24h).toBe(12);
  });

  it('reports unknown guardian rows explicitly at the freshness boundary', async () => {
    const root = fixture();
    writeFileSync(join(root, 'supervisor', 'status-main-guardian.md'), '# Main guardian status (2026-11-11 11:30:00)\n| phantom | master | abcdef1 | unknown | | | | |');
    const result = await snapshot(root);
    expect(result.mains).toMatchObject({ guardianState: 'fresh', known: true, stale: false, green: 0, red: 0, total: 1, unknown: 1 });
    expect(renderLeaderStatus(result)).toContain('Unknown: 1. Guardian checked:');
  });
});

describe('Leader state completeness', () => {
  it.each(['', '  \n', '{}'])('distinguishes empty input %j from measured zero and stale data', async text => {
    const root = fixture();
    writeFileSync(join(root, 'queue/status.json'), text);
    expect(await snapshot(root)).toMatchObject({ queueState: 'empty', running: null, queued: null, merged24h: null });
    writeFileSync(join(root, 'queue/status.json'), JSON.stringify({ last_tick: new Date(now).toISOString(), lanes: { codex: { running: 0, queued: 0 } }, rollup_24h: { merged: 0 } }));
    const zero = await snapshot(root);
    expect(zero).toMatchObject({ queueState: 'fresh', running: 0, queued: 0, merged24h: 0 });
    expect(renderLeaderStatus(zero)).toContain('Fleet activity: 0 running, 0 queued.');
  });

  it.each([
    [{}, null, null], [{ codex: {} }, null, null],
    [{ codex: { running: 0, queued: '0' } }, 0, null],
    [{ codex: { running: -1, queued: 2 } }, null, 2],
    [{ codex: { running: 1, queued: 2 }, 'bad/name': { running: 1, queued: 2 } }, null, null],
    [{ a: { running: Number.MAX_SAFE_INTEGER, queued: 1 }, b: { running: 1, queued: 2 } }, null, 3],
  ])('keeps each incomplete or overflowing activity total unknown: %j', async (lanes, running, queued) => {
    const root = fixture();
    writeFileSync(join(root, 'queue/status.json'), JSON.stringify({ last_tick: new Date(now).toISOString(), lanes }));
    expect(await snapshot(root)).toMatchObject({ running, queued });
  });

  it('counts all fresh lanes before capping the displayed rows', async () => {
    const root = fixture();
    const lanes = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`lane${i}`, { running: 1, queued: 2 }]));
    writeFileSync(join(root, 'queue/status.json'), JSON.stringify({ last_tick: new Date(now).toISOString(), lanes, rollup_24h: { merged: 7 } }));
    const result = await snapshot(root);
    expect(result).toMatchObject({ running: 20, queued: 40, merged24h: 7, laneActivityTruncated: true });
    expect(result.laneActivity).toHaveLength(16);
    expect(renderLeaderStatus(result)).toContain('Showing the first 16 lanes.');
  });

  it('exposes empty guardian evidence and the off marker without inventing healthy mains', async () => {
    const root = fixture();
    writeFileSync(join(root, 'supervisor/status-main-guardian.md'), '# Main guardian status (2026-11-11 12:00:00)');
    expect((await snapshot(root)).mains).toMatchObject({ guardianState: 'empty', known: false, green: null, total: null });
    writeFileSync(join(root, 'queue/MAIN_GUARDIAN_OFF'), '');
    const result = await snapshot(root);
    expect(result.mains.guardianState).toBe('off');
    expect(renderLeaderStatus(result)).toContain('Guardian: off.');
  });

  it.each(['queue', 'guardian', 'journal'])('isolates a rejected %s collector without exposing its error', async source => {
    const root = fixture(); writeQueue(root, new Date(now).toISOString());
    const fail = async () => { throw new Error('synthetic-private-error'); };
    if (source === 'guardian') vi.spyOn(mainHealth, 'readFleetMainHealth').mockImplementation(fail);
    else if (source === 'journal') vi.spyOn(journal, 'readLeaderJournal').mockImplementation(fail);
    else {
      const read = queueSource.readSource;
      vi.spyOn(queueSource, 'readSource').mockImplementation((...args) => args[0].endsWith('status.json') ? fail() : read(...args));
    }
    const result = await snapshot(root);
    expect(result.merged24h).toBe(source === 'queue' ? null : 12);
    expect(result.mains.guardianState).toBe(source === 'guardian' ? 'unavailable' : 'fresh');
    expect(result.ceo).toEqual(source === 'journal' ? [] : ['Work continues.']);
    expect(JSON.stringify(result) + renderLeaderStatus(result)).not.toContain('synthetic-private-error');
  });
});
