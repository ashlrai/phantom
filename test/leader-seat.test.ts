import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLeaderSeat, leaderSeatText } from '../src/core/fleet/leader-seat.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { getLaneModelSnapshot } from '../src/core/fleet/lane-models.js';
import { loadVerifiedRegistry } from '../src/core/fleet/model-verify.js';

const AT = '2026-11-17T12:00:00Z', now = () => Date.parse(AT), reset = '2026-11-18T12:00:00Z';
const lane = (health = 'ok', ms = 1000) => ({ running: 0, target: 1, queued: 0, held: false, health, leader_pass_at: AT, leader_pass_ms: ms });
const status = () => ({ last_tick: AT, paused: false, mem_free_pct: 50,
  leader: { lane: 'claude', model: 'model-a', last_success_at: AT },
  lanes: { claude: lane(), 'codex-personal': lane('ok', 2000), gemini: lane('ok', 3000) },
  budget: Object.fromEntries(['claude', 'codex-personal', 'gemini'].map((name, i) => [name, { weekly_used_pct: 40 - i * 10, observed_at: AT, reset_at: reset }])) });
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(s = status(), unconfirmed = '') {
  const root = await mkdtemp(join(tmpdir(), 'leader-seat-')); roots.push(root);
  await mkdir(join(root, 'queue'));
  await writeFile(join(root, 'queue/status.json'), JSON.stringify(s));
  await writeFile(join(root, 'models.json'), JSON.stringify({ claude: 'model-a', codex: 'model-b', gemini: 'model-c' }));
  const registryPath = join(root, 'registry.json');
  await writeFile(registryPath, JSON.stringify(['model-a', 'model-b', 'model-c'].map(id => ({ id, provider: 'openai',
    status: id === unconfirmed ? 'unverified' : 'verified', verified_source: 'https://developers.openai.com/api/docs/models', verified_at: '2026-11-17' }))));
  return { status: () => readFleetRunsDirState({ runsDir: root, now }), models: () => getLaneModelSnapshot({ runsDir: root }),
    registry: () => loadVerifiedRegistry({ registryPath, now }), now };
}
describe('leader seat fixtures', () => {
  it('ranks all healthy lanes by included usage and exposes a stable versioned report', async () => {
    const read = await fixture(), report = await readLeaderSeat(read);
    expect(report).toMatchObject({ schema: 'leader.seat.v1', version: 1, current: { lane: 'claude', model: 'model-a', lastSuccessAt: AT }, pick: { lane: 'gemini', headroomPct: 80 } });
    expect(report.fallbacks.map(s => s.lane)).toEqual(['gemini', 'codex-personal']);
    expect(JSON.stringify(await readLeaderSeat(read))).toBe(JSON.stringify(report));
    expect(leaderSeatText(report)).toContain('Last successful pass: ' + AT);
  });
  it('moves from a down current lane to the next healthy company', async () => {
    const s = status(); s.lanes.claude.health = 'down'; s.lanes.gemini.health = 'degraded';
    expect((await readLeaderSeat(await fixture(s))).pick?.lane).toBe('codex-personal');
  });
  it('returns none with a reason when every lane is unknown', async () => {
    const s = status(); Object.values(s.lanes).forEach(l => { l.health = 'unknown'; });
    const report = await readLeaderSeat(await fixture(s));
    expect(report.pick).toBeNull(); expect(report.reason).toBe('No seat: lane health is unknown.');
    expect(report.fallbacks.every(l => l.health === 'unknown')).toBe(true);
  });
  it('never picks an unconfirmed model even with the most headroom', async () => {
    const report = await readLeaderSeat(await fixture(status(), 'model-c'));
    expect(report.pick?.lane).toBe('codex-personal');
    expect(report.fallbacks.find(l => l.lane === 'gemini')).toMatchObject({ confirmed: false, eligible: false, reason: 'Model is not confirmed in the registry.' });
  });
  it('breaks usage ties by pass speed, then exact ties by lane ID regardless of input order', async () => {
    const s = status(); Object.values(s.budget).forEach(b => { b.weekly_used_pct = 50; });
    expect((await readLeaderSeat(await fixture(s))).pick?.lane).toBe('claude');
    Object.values(s.lanes).forEach(l => { l.leader_pass_ms = 1000; });
    s.lanes = Object.fromEntries(Object.entries(s.lanes).reverse()) as typeof s.lanes;
    expect((await readLeaderSeat(await fixture(s))).pick?.lane).toBe('claude');
  });
  it('keeps absent leader and health evidence unknown and does not infer it from running jobs', async () => {
    const s = status(); Reflect.deleteProperty(s, 'leader');
    Object.values(s.lanes).forEach(l => { Reflect.deleteProperty(l, 'health'); l.running = 1; });
    const report = await readLeaderSeat(await fixture(s));
    expect(report.current).toEqual({ lane: null, model: null, lastSuccessAt: null }); expect(report.pick).toBeNull();
    expect(leaderSeatText(report)).toContain('Leader seat: unknown · model unknown');
  });
  it('expires status, quota and timing independently; held and exhausted lanes cannot win', async () => {
    const s = status(); s.lanes.gemini.held = true; s.budget['codex-personal']!.weekly_used_pct = 101;
    expect((await readLeaderSeat(await fixture(s))).pick?.lane).toBe('claude');
    s.budget.claude!.reset_at = AT; s.lanes.claude.leader_pass_at = '2026-11-16T12:00:00Z';
    expect((await readLeaderSeat(await fixture(s))).pick).toMatchObject({ headroomPct: null, recentPassMs: null });
    s.last_tick = '2026-11-16T12:00:00Z';
    const stale = await readLeaderSeat(await fixture(s)); expect(stale.pick).toBeNull(); expect(stale.current.lane).toBeNull();
  });
  it('treats unavailable readers as unknown without failing the other sources', async () => {
    const read = await fixture(); const unavailable = async (): Promise<never> => { throw new Error('fixture unavailable'); };
    expect((await readLeaderSeat({ ...read, registry: unavailable })).pick).toBeNull();
    const missing = await readLeaderSeat({ ...read, status: unavailable });
    expect(missing.fallbacks).toEqual([]); expect(missing.reason).toContain('unknown');
  });
});
