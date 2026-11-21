/**
 * Planner fallback slate: the tick says plainly when none is declared, and
 * `planner-slate --propose` prints a read-only proposal ordered by pool state.
 * Hermetic: temp runs dir, injected clock and binary lookup, no subprocess.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetPlannerSlate } from '../src/cli/fleet-planner-slate.js';
import { decidePlannerAutorun, readPlannerAutorunInput, type PlannerAutorunInput } from '../src/core/fleet/planner-autorun.js';
import { proposePlannerSlate } from '../src/core/fleet/planner-slate-propose.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const iso = (hoursFromNow: number): string => new Date(NOW + hoursFromNow * 3_600_000).toISOString();
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function runsDir(budget: Record<string, Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'slate-propose-')); dirs.push(dir);
  mkdirSync(join(dir, 'queue'), { recursive: true });
  const lanes = Object.fromEntries(Object.keys(budget).map((lane) => [lane, { running: 0, target: 1, held: false }]));
  writeFileSync(join(dir, 'queue', 'status.json'), JSON.stringify({ last_tick: iso(0), lanes, budget }));
  return dir;
}
const reading = (usedPct: number, resetInHours: number): Record<string, unknown> =>
  ({ weekly_used_pct: usedPct, reset_at: iso(resetInHours), observed_at: iso(0) });
const installed = (): boolean => true;
const snapshot = (dir: string): string[] => readdirSync(join(dir, 'queue')).sort();

const failing: PlannerAutorunInput = {
  phxReady: 0, lanes: [{ lane: 'devin', running: 0, target: 1, held: false }], orchOff: false, nowMs: NOW,
  health: { status: 'failing', failingSince: iso(-1), lastGoodPassAt: null, resetAt: iso(27), reason: 'usage-limit' },
};

describe('planner-tick names the missing slate', () => {
  it('says so in plain words and carries slate:"missing"', () => {
    const d = decidePlannerAutorun({ ...failing, slateState: 'missing', slate: [] });
    expect(d.run).toBe(false);
    expect(d.slate).toBe('missing');
    expect(d.detail).toContain('No planner fallback list declared at queue/planner-candidates.json; only the usual login can run');
  });

  it('reads the state from the runs dir: absent file is missing, broken file is invalid', async () => {
    const dir = runsDir({});
    expect((await readPlannerAutorunInput(dir, NOW)).slateState).toBe('missing');
    writeFileSync(join(dir, 'queue', 'planner-candidates.json'), 'not a slate');
    const input = await readPlannerAutorunInput(dir, NOW);
    expect(input.slateState).toBe('invalid');
    const d = decidePlannerAutorun({ ...failing, slateState: input.slateState });
    expect(d.slate).toBe('invalid');
    expect(d.detail).toContain('cannot be read');
  });

  it('a good slate reads ok and adds no gap sentence', async () => {
    const dir = runsDir({});
    writeFileSync(join(dir, 'queue', 'planner-candidates.json'),
      JSON.stringify({ v: 1, candidates: [{ provider: 'claude', argv: ['claude-fake'] }] }));
    const input = await readPlannerAutorunInput(dir, NOW);
    expect(input.slateState).toBe('ok');
    expect(decidePlannerAutorun({ ...failing, slateState: 'ok', slate: [] }).detail).not.toContain('fallback list');
  });
});

describe('planner-slate --propose', () => {
  it('orders lanes by soonest reset, skips used-up and unknown pools, and writes nothing', async () => {
    const dir = runsDir({
      claude: reading(32, 40),
      'codex-personal': reading(60, 10),
      devin: reading(10, 5),
      'codex-cmp': reading(100, 3),
    });
    const before = snapshot(dir);
    const p = await proposePlannerSlate({ runsDir: dir, home: '/home/fixture', now: NOW, exists: installed });
    expect(p.current).toBe('missing');
    expect(p.lanes.map((l) => l.provider)).toEqual(['codex-personal', 'claude']);
    expect(p.slate?.candidates.map((c) => c.provider)).toEqual(['codex-personal', 'claude']);
    expect(p.skipped.map((s) => s.pool).sort()).toEqual(['codex-cmp', 'devin']);
    expect(p.skipped.find((s) => s.pool === 'devin')?.why).toContain('no runner command');
    expect(snapshot(dir)).toEqual(before);
  });

  it('proposes nothing when no pool has usage left, and a missing runner is left out', async () => {
    const dir = runsDir({ claude: reading(100, 20), 'codex-personal': reading(5, 20) });
    const none = await proposePlannerSlate({ runsDir: dir, home: '/home/fixture', now: NOW, exists: () => false });
    expect(none.slate).toBeNull();
    expect(none.notes.join(' ')).toContain('nothing to propose');
    expect(none.skipped.find((s) => s.pool === 'codex-personal')?.why).toContain('not installed');
  });

  it('never puts an environment value in the argv', async () => {
    const dir = runsDir({ claude: reading(32, 40) });
    const secretish = 'fixture-environment-marker';
    const prior = process.env['ANTHROPIC_FIXTURE_NOTE'];
    process.env['ANTHROPIC_FIXTURE_NOTE'] = secretish;
    try {
      const p = await proposePlannerSlate({ runsDir: dir, home: '/home/fixture', now: NOW, exists: installed });
      expect(JSON.stringify(p)).not.toContain(secretish);
    } finally { if (prior === undefined) delete process.env['ANTHROPIC_FIXTURE_NOTE']; else process.env['ANTHROPIC_FIXTURE_NOTE'] = prior; }
  });

  it('the verb prints JSON, refuses --file with --propose, and leaves the runs dir alone', async () => {
    const dir = runsDir({});
    const before = snapshot(dir);
    let out = '';
    const io = { stdout: { write(t: string) { out += t; } } };
    expect(await cmdFleetPlannerSlate(['--propose', '--json', '--runs-dir', dir], io)).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ v: 1, current: 'missing', slate: null });
    out = '';
    expect(await cmdFleetPlannerSlate(['--propose', '--runs-dir', dir], io)).toBe(0);
    expect(out).toContain('No planner fallback list is declared');
    out = '';
    expect(await cmdFleetPlannerSlate(['--propose', '--file', '-'], io)).toBe(2);
    expect(snapshot(dir)).toEqual(before);
  });
});
