import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readGuardianGlance } from '../src/core/fleet/guardian-glance.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const now = new Date(2026, 10, 2, 12, 0, 0);
const ago = (min: number) => stamp(new Date(now.getTime() - min * 60_000));

function runsDir(table: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-glance-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'supervisor'), { recursive: true });
  writeFileSync(join(dir, 'supervisor', 'status-main-guardian.md'), table);
  return dir;
}

describe('readGuardianGlance', () => {
  it('orders red, stale, green and flags stale past 90 minutes', async () => {
    const dir = runsDir([
      `# Main guardian status (${ago(1)})`, '',
      '| repo | branch | sha | state | checked | failing | fixes | nightly |',
      '|---|---|---|---|---|---|---|---|',
      `| alpha | main | abc1234 | green | ${ago(10)} | | | |`,
      `| beta | main | def5678 | red | ${ago(5)} | typecheck | fix-1, fix-2 | |`,
      `| gamma | main | 0123abc | green | ${ago(120)} | | | |`,
      '| broken | main |',
      '',
    ].join('\n'));
    const rows = await readGuardianGlance(dir, now.getTime());
    expect(rows.map((r) => [r.repo, r.state, r.stale])).toEqual([
      ['beta', 'red', false], ['gamma', 'green', true], ['alpha', 'green', false],
    ]);
    expect(rows[0]).toMatchObject({ ageMinutes: 5, openFixes: 2 });
    expect(rows[1]!.ageMinutes).toBe(120);
  });

  it('marks an unreadable time or state unknown and never throws', async () => {
    const dir = runsDir(`# Main guardian status (${ago(1)})\n| delta | main | abc1234 | ??? | nonsense | | | |\n`);
    expect(await readGuardianGlance(dir, now.getTime())).toEqual([
      { repo: 'delta', state: 'unknown', lastPassAt: null, ageMinutes: null, openFixes: 0, stale: true },
    ]);
    expect(await readGuardianGlance(join(dir, 'missing'), now.getTime())).toEqual([]);
  });
});
