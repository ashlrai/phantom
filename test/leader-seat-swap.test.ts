import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLeaderSeat, type LeaderSeatReport } from '../src/core/fleet/leader-seat.js';
import { buildSeatSwap, seatPoolName, seatSwapText, writeSeatSwapDraft } from '../src/core/fleet/leader-seat-swap.js';
import { cmdFleetLeaderSeat } from '../src/cli/fleet-leader-seat.js';
import type { PoolsViewV1 } from '../src/core/fleet/pools-view.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

// Nov 21, 10:00 ET.
const NOW = Date.parse('2026-11-21T15:00:00Z'), TZ = 'America/New_York';
const BACK = '2026-11-21T20:30:00Z'; // 3:30 PM ET
const WEEK = '2026-11-27T17:00:00Z';
const registry = ['claude-opus-5-5', 'gpt-6.1-sol'].map(id => ({ id, provider: 'fixture', status: 'verified' as const,
  verified_source: 'https://example.com/models', verified_at: '2026-11-17' }));
const models = { claude: 'claude-opus-5-5', codex: 'gpt-6.1-sol' };

function report(used: { claude: number; codex: number }, extra: { claudeRate?: string } = {}): LeaderSeatReport {
  const at = new Date(NOW - 60_000).toISOString();
  const lane = (name: string, usedPct: number, resetAt: string) => ({ lane: name, held: false, healthy: true, running: 0, target: 1, queued: 0,
    seat: { health: 'ok' as const, usedPct, observedAt: at, resetAt, passAt: at, passMs: 1000, rateLimitedAt: name === 'claude' ? extra.claudeRate ?? null : null, failedAt: null } });
  const runs = { sources: { status: 'healthy' }, lastTick: at, paused: false, leader: { lane: 'claude', model: 'claude-opus-5-5', lastSuccessAt: at },
    lanes: [lane('claude', used.claude, WEEK), lane('codex-personal', used.codex, used.codex >= 100 ? BACK : WEEK)] } as unknown as FleetRunsDirState;
  const snapshot = { lanes: Object.entries({ claude: models.claude, 'codex-personal': models.codex }).map(([name, model]) =>
    ({ lane: name, tiers: [{ tier: 'frontier', model }] })) } as never;
  return buildLeaderSeat(runs, snapshot, registry, NOW);
}
const pools = (emptyAt: string | null): PoolsViewV1 => ({ schema: 'pools.v1', generatedAt: new Date(NOW).toISOString(), staleAfterMinutes: 60, gaps: [],
  pools: [{ id: 'claude', projectedEmptyAt: emptyAt, usedPct: 96 }] as never });
const build = (r: LeaderSeatReport, p: PoolsViewV1 | null, failures = 0) => buildSeatSwap(r, p, NOW, { usageLimitFailures: failures, timeZone: TZ });

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('leader seat swap', () => {
  it('names pools in plain words', () => {
    expect(seatPoolName('claude')).toBe('Claude');
    expect(seatPoolName('codex-personal')).toBe('personal Codex');
  });

  it('seat ok: stays on the current seat and names the next one', () => {
    const view = build(report({ claude: 40, codex: 10 }), pools(null));
    expect(view).toMatchObject({ moveNeeded: false, proposal: null, runsNext: { lane: 'claude' }, next: { lane: 'codex-personal', usable: true } });
    expect(view.line).toBe('Leader runs on Opus 5.5; Claude 40% used; next seat: personal Codex now');
    expect(view.fallbacks.map(s => s.line)).toEqual(['personal Codex: ok, 10% used']);
  });

  it('says when the pool is on course to be empty and when the next seat is back', () => {
    const view = build(report({ claude: 90, codex: 100 }), pools('2026-11-23T19:00:00Z'));
    expect(view.moveNeeded).toBe(false);
    expect(view.line).toBe('Leader runs on Opus 5.5; Claude empty about Mon 2 PM; next seat: personal Codex from 3:30 PM');
    expect(view.fallbacks[0]!.line).toBe('personal Codex: used up, back 3:30 PM');
  });

  it('pool at 98% with a fallback ready: moves and hands Security one line', () => {
    const view = build(report({ claude: 98, codex: 10 }), pools(null));
    expect(view).toMatchObject({ moveNeeded: true, moveWhy: 'Claude is 98% used', runsNext: { lane: 'codex-personal' } });
    expect(view.line).toBe('Leader should move to personal Codex now: Claude is 98% used.');
    expect(view.proposal).toMatchObject({ from: 'claude -p --model claude-opus-5-5', to: 'codex exec --model gpt-6.1-sol -', applyFrom: null });
    expect(view.proposal!.line).toBe('Leader pass command: claude -p --model claude-opus-5-5  ->  codex exec --model gpt-6.1-sol -');
    expect(seatSwapText(view)).toContain('Wrapper change for Security:');
  });

  it('two usage-limit failures also call for a move, even below 98%', () => {
    expect(build(report({ claude: 60, codex: 10 }), null, 1).moveNeeded).toBe(false);
    expect(build(report({ claude: 60, codex: 10 }), null, 2)).toMatchObject({ moveNeeded: true, moveWhy: 'the last 2 leader passes hit a usage limit' });
  });

  it('all pools out: no seat until the earliest reset', () => {
    const view = build(report({ claude: 100, codex: 100 }), null);
    expect(view.runsNext).toBeNull();
    expect(view.line).toBe('No seat until 3:30 PM (personal Codex).');
    expect(view.proposal).toMatchObject({ applyFrom: BACK, to: 'codex exec --model gpt-6.1-sol -' });
    expect(view.proposal!.line).toContain('(apply from 3:30 PM)');
  });

  it('never puts env values or credentials in the proposal', () => {
    const line = build(report({ claude: 99, codex: 10 }), null).proposal!.line;
    expect(line).not.toMatch(/=|token|key|secret|cookie|password/i);
  });

  it('writes the proposal to leader/drafts and nothing when there is none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seat-swap-')); roots.push(root);
    expect(await writeSeatSwapDraft(build(report({ claude: 10, codex: 10 }), null), root)).toBeNull();
    const file = await writeSeatSwapDraft(build(report({ claude: 99, codex: 10 }), null), root);
    expect(file).toBe(join(root, 'leader', 'drafts', 'seat-swap.txt'));
    expect(await readFile(file!, 'utf8')).toMatch(/^Leader pass command: claude -p .* {2}-> {2}codex exec .*\n$/);
  });

  it('the CLI prints the view, saves the proposal and exits 3 only when no seat is usable', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((text: string) => { out.push(text); });
    const write = vi.fn(async () => '/fixture/leader/drafts/seat-swap.txt');
    const code = await cmdFleetLeaderSeat(['--json', '--runs-dir', '/fixture'], { read: async () => build(report({ claude: 99, codex: 10 }), null), write });
    expect(code).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ schema: 'leader.seat-swap.v1', moveNeeded: true, draft: '/fixture/leader/drafts/seat-swap.txt' });
    expect(await cmdFleetLeaderSeat([], { read: async () => build(report({ claude: 100, codex: 100 }), null), write: async () => null })).toBe(3);
    expect(out[1]).toContain('No seat until 3:30 PM');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetLeaderSeat(['--bogus'])).toBe(2);
  });
});
