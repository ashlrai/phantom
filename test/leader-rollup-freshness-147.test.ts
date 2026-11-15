import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLeaderStatusSnapshot, renderLeaderStatus } from '../src/core/comms/leader-status-snapshot.js';

const now = Date.parse('2026-11-11T12:00:00Z');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
    expect(result).toMatchObject({ merged24h: null, medianTtmS: null, lanes: [], mains: { known: true, green: 1 }, ceo: ['Work continues.'] });
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
});
