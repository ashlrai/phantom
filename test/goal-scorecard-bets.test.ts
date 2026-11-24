import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGoalScorecard, jobsGoalTally, parseVisionBets, readGoalScorecard, renderGoalScorecard } from '../src/core/fleet/goal-scorecard.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();
const row = (v: Record<string, unknown>) => JSON.stringify(v);
const jobsOf = (lines: string[] | null) => { const t = jobsGoalTally(NOW); for (const l of lines ?? []) t.add(l); return t.report(lines !== null); };
const card = (lines: string[] | null, vision?: { text: string; at: number | null } | null) =>
  buildGoalScorecard({ now: NOW, jobs: jobsOf(lines), status: null, mains: null, releaseLines: null, ...(vision !== undefined ? { vision } : {}) });
const wasted = (c: ReturnType<typeof card>) => c.goals.find(g => g.id === 'wasted-launch-rate')!;

describe('wasted-launch-rate goal', () => {
  it('shares EMPTY outcomes of jobs finished in 24 h, overall and per lane', () => {
    const lines = [
      row({ event: 'launch', job: 'a', lane: 'claude', ts: ago(300) }), row({ event: 'outcome', job: 'a', state: 'EMPTY', ts: ago(200) }),
      row({ event: 'launch', job: 'b', lane: 'claude', ts: ago(300) }), row({ event: 'outcome', job: 'b', state: 'MERGED', ts: ago(190) }),
      row({ event: 'launch', job: 'c', lane: 'zai', ts: ago(300) }), row({ event: 'outcome', job: 'c', state: 'MERGED', ts: ago(180) }),
      row({ event: 'launch', job: 'd', lane: 'zai', ts: ago(300) }), row({ event: 'outcome', job: 'd', state: 'OPEN', ts: ago(170) }), // not finished
      row({ event: 'outcome', job: 'old', state: 'EMPTY', lane: 'zai', ts: ago(30 * 60) }), // older than 24 h
    ];
    const g = wasted(card(lines));
    expect(g).toMatchObject({ current: 0.333, target: 0.2, better: 'lower', status: 'behind', unit: 'share' });
    expect(g.parts).toEqual([{ name: 'claude', value: 0.5 }, { name: 'zai', value: 0 }]);
  });
  it('is on track at or under the target', () => {
    const lines = [row({ event: 'outcome', job: 'a', state: 'MERGED', ts: ago(10) }), row({ event: 'outcome', job: 'b', state: 'MERGED', ts: ago(20) })];
    expect(wasted(card(lines))).toMatchObject({ current: 0, status: 'on-track', parts: [{ name: 'lane not recorded', value: 0 }] });
  });
  it('is unknown, not 0, with no finished jobs or no ledger', () => {
    const quiet = wasted(card([row({ event: 'launch', job: 'a', ts: ago(5) })]));
    expect(quiet).toMatchObject({ current: null, status: 'unknown', currentText: 'unknown' });
    expect(quiet.reason).toBe('No job finished in the last 24 hours.');
    expect(wasted(card(null))).toMatchObject({ current: null, status: 'unknown', reason: 'The jobs ledger could not be read.' });
  });
});

describe('vision bets and end state', () => {
  const text = [
    '# Ship fewer, better PRs', '',
    '- READY RQ-ONE (P1, pool=claude, tier=work, repo=phantom, size<=200): Fix the thing. Acceptance: tests.',
    '- READY RQ-TWO (P0, src=leader): No pool here',
    '- READY RQ-ONE (P1, pool=zai): duplicate id is ignored',
    '- DONE RQ-OLD (P1, pool=claude): not a bet',
  ].join('\n');
  it('parses READY lines into id, pool, repo and goal', () => {
    expect(parseVisionBets(text)).toEqual([
      { id: 'RQ-ONE', pool: 'claude', repo: 'phantom', goal: 'Fix the thing. Acceptance: tests.' },
      { id: 'RQ-TWO', pool: null, repo: null, goal: 'No pool here' },
    ]);
  });
  it('fills bets, source, as_of and end_state_text when the vision is present', () => {
    const c = card([], { text, at: NOW - 60_000 });
    expect(c).toMatchObject({ schema: 'fleet.goal-scorecard.v3', end_state_text: 'Ship fewer, better PRs', bets_source: 'leader/VISION.md', bets_reason: null, as_of: ago(1) });
    expect(c.bets).toHaveLength(2);
    expect(renderGoalScorecard(c)).toContain('Current bets:\n  RQ-ONE (claude, phantom): Fix the thing.');
  });
  it('says so plainly when the vision is missing or has no bets', () => {
    expect(card([])).toMatchObject({ end_state_text: null, bets: [], bets_source: null, as_of: null, bets_reason: 'The leader vision file is missing or could not be read.' });
    expect(card([], { text: 'Only a title', at: null })).toMatchObject({ end_state_text: 'Only a title', bets: [], bets_reason: 'The leader vision file lists no READY bets.', as_of: null });
  });
  it('reads leader/VISION.md under the runs dir, and a missing file is not a crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goals-vision-'));
    const empty = await readGoalScorecard({ runsDir: dir, now: () => NOW, readLines: async () => false, readMains: async () => null });
    expect(empty.bets).toEqual([]); expect(empty.end_state_text).toBeNull();
    mkdirSync(join(dir, 'leader'));
    writeFileSync(join(dir, 'leader', 'VISION.md'), text);
    const full = await readGoalScorecard({ runsDir: dir, now: () => NOW, readLines: async () => false, readMains: async () => null });
    expect(full.bets?.map(b => b.id)).toEqual(['RQ-ONE', 'RQ-TWO']);
    expect(full.as_of).toMatch(/^\d{4}-/);
  });
});
