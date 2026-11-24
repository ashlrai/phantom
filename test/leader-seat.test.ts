import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as seat from '../src/core/fleet/leader-seat.js';
import { readLeaderSeat, leaderSeatText } from '../src/core/fleet/leader-seat.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { getLaneModelSnapshot } from '../src/core/fleet/lane-models.js';
import { loadVerifiedRegistry, type VerifiedModelRegistryEntry } from '../src/core/fleet/model-verify.js';
import { runLeaderCli } from '../src/cli/leader.js';

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
    expect(report.current).toEqual({ lane: null, model: null, lastSuccessAt: null, used_pct: null, reset_at: null }); expect(report.pick).toBeNull();
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

// RQ-LEADERSEATN19BQ8: model-agnostic seating. pickSeat, rate limits and failures, the seat line, and the dry-run command.
describe('leader seat pick, rate limits and dry-run', () => {
  // The original reader, captured before any CLI test spies on the module export.
  const { pickSeat, readLeaderSeat: readSeat, leaderSeatLine, leaderSeatCommand, seatModelName } = seat;
  const AT = '2026-11-17T12:00:00Z', now = () => Date.parse(AT), reset = '2026-11-20T00:00:00Z';
  const ago = (min: number) => new Date(now() - min * 60_000).toISOString().replace('.000Z', 'Z');
  const lane = (extra: Record<string, unknown> = {}) => ({ running: 0, target: 1, queued: 0, held: false, health: 'ok', ...extra });
  const budget = (used: number) => ({ weekly_used_pct: used, observed_at: AT, reset_at: reset });
  const status = () => ({ last_tick: AT, paused: false, mem_free_pct: 50,
    leader: { lane: 'claude', model: 'claude-opus-5-5', last_success_at: AT },
    lanes: { claude: lane(), 'codex-personal': lane(), gemini: lane() } as Record<string, ReturnType<typeof lane>>,
    budget: { claude: budget(20), 'codex-personal': budget(40), gemini: budget(60) } as Record<string, unknown> });
  const entry = (id: string, verified = true): VerifiedModelRegistryEntry => ({ id, provider: 'plain', status: verified ? 'verified' : 'unverified',
    verified_source: verified ? 'docs' : null, verified_at: verified ? '2026-11-01' : null });
  const roots: string[] = [];
  afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

  async function read(s = status(), unconfirmed: string[] = [], failures: seat.LeaderSeatFailure[] = []) {
    const root = await mkdtemp(join(tmpdir(), 'leader-seat-pick-')); roots.push(root);
    await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'queue/status.json'), JSON.stringify(s));
    await writeFile(join(root, 'models.json'), JSON.stringify({ claude: 'claude-opus-5-5', codex: 'gpt-6.1-sol', gemini: 'gemini-3-pro' }));
    return readSeat({ status: () => readFleetRunsDirState({ runsDir: root, now }), models: () => getLaneModelSnapshot({ runsDir: root }),
      registry: async () => ['claude-opus-5-5', 'gpt-6.1-sol', 'gemini-3-pro'].map(id => entry(id, !unconfirmed.includes(id))),
      failures: async () => failures, now });
  }

  describe('seat report for launchers (RQ-LEADERSEATN20SQ8)', () => {
    const { launcherSeat, leaderChip } = seat;
    it('healthy seat keeps the leader and reports its usage and reset', async () => {
      const report = await read();
      expect(report).toMatchObject({ healthy: true, current: { lane: 'claude', used_pct: 20, reset_at: reset } });
      expect(launcherSeat(report)).toEqual({ lane: 'claude', model: 'claude-opus-5-5' });
      expect(leaderChip(report)).toEqual({ model: 'Opus 5.5', lane: 'claude', used_pct: 20, reset_at: reset, warn: false });
    });
    it('drained seat moves to two fallbacks, soonest reset first', async () => {
      const s = status(); s.budget.claude = budget(100);
      s.budget['codex-personal'] = { weekly_used_pct: 40, observed_at: AT, reset_at: '2026-11-23T00:00:00Z' };
      s.budget.gemini = { weekly_used_pct: 60, observed_at: AT, reset_at: '2026-11-19T00:00:00Z' };
      const report = await read(s);
      expect(report.healthy).toBe(false);
      expect(report.fallback?.map(f => [f.lane, f.used_pct, f.reset_at])).toEqual([['gemini', 60, '2026-11-19T00:00:00Z'], ['codex-personal', 40, '2026-11-23T00:00:00Z']]);
      expect(report.fallback_reason).toBeNull();
      expect(launcherSeat(report)).toEqual({ lane: 'gemini', model: 'gemini-3-pro' });
      expect(leaderChip(report).warn).toBe(true);
    });
    it('no usable fallback says so plainly and picks nothing', async () => {
      const s = status(); for (const name of Object.keys(s.lanes)) s.budget[name] = budget(100);
      const report = await read(s);
      expect(report.fallback).toEqual([]);
      expect(report.fallback_reason).toBe('No other plan has usage left.');
      expect(launcherSeat(report)).toBeNull();
      expect(leaderSeatText(report)).toContain('No other plan has usage left.');
    });
    it('lanes with no usage reading are skipped, not guessed', async () => {
      const s = status(); s.budget.claude = budget(100); delete s.budget.gemini;
      expect((await read(s)).fallback?.map(f => f.lane)).toEqual(['codex-personal']);
    });
  });

  describe('pickSeat', () => {
    it('primary healthy: keeps the leader on the pool with the most runway and names the fallback', async () => {
      const report = await read();
      expect(pickSeat(report)).toEqual({ ok: true, pool: 'claude', model: 'claude-opus-5-5', cli: 'claude',
        reason: 'Lane ok, confirmed model, not rate-limited in the last hour; 80% of included usage left.',
        next: { pool: 'codex-personal', model: 'gpt-6.1-sol', cli: 'codex' } });
      expect(leaderSeatLine(report)).toBe('Leader: Opus 5.5 on Claude, next: GPT-6.1 Sol on Codex');
    });
    it('primary exhausted: moves to the next frontier pool', async () => {
      const s = status(); s.budget.claude = budget(100);
      const report = await read(s);
      expect(pickSeat(report)).toMatchObject({ ok: true, pool: 'codex-personal', model: 'gpt-6.1-sol', cli: 'codex', next: { pool: 'gemini' } });
      expect(report.currentSeat?.reason).toBe('Included usage is exhausted.');
    });
    it('uses the use_it_all reading when no weekly reading exists', async () => {
      const s = status(); s.budget.claude = { use_it_all: { known: true, stale: false, used_pct: 100, reset_at: reset } };
      expect(pickSeat(await read(s)).pool).toBe('codex-personal');
      s.budget.claude = { use_it_all: { known: true, stale: true, used_pct: 100, reset_at: reset } };
      expect((await read(s)).currentSeat).toMatchObject({ headroomPct: null, eligible: true });
    });
    it('primary rate-limited in the last hour: skipped; an older limit no longer counts', async () => {
      const s = status(); s.lanes.claude = lane({ rate_limited_at: ago(30) });
      const report = await read(s);
      expect(pickSeat(report).pool).toBe('codex-personal');
      expect(report.currentSeat).toMatchObject({ rateLimitedAt: ago(30), reason: 'Rate-limited in the last hour.' });
      s.lanes.claude = lane({ rate_limited_at: ago(90) });
      expect(pickSeat(await read(s)).pool).toBe('claude');
    });
    it('a failed leader pass from the recent-failure list moves the seat too', async () => {
      const report = await read(status(), [], [{ lane: 'claude', at: ago(5), kind: 'failed' }]);
      expect(pickSeat(report).pool).toBe('codex-personal');
      expect(report.currentSeat?.reason).toBe('A leader pass failed here in the last hour.');
    });
    it('all exhausted: a plain reason per pool and no seat', async () => {
      const s = status(); for (const name of Object.keys(s.lanes)) s.budget[name] = budget(100);
      const choice = pickSeat(await read(s));
      expect(choice).toMatchObject({ ok: false, pool: null, model: null, cli: null, next: null });
      expect(choice.reason).toBe('No seat available. claude: Included usage is exhausted. codex-personal: Included usage is exhausted. gemini: Included usage is exhausted.');
      expect(leaderSeatLine(await read(s))).toMatch(/^Leader: no seat available\. Claude: Included usage is exhausted\./);
    });
    it('unconfirmed model skipped even with the most runway; never routed', async () => {
      const report = await read(status(), ['claude-opus-5-5']);
      expect(pickSeat(report)).toMatchObject({ pool: 'codex-personal', next: { pool: 'gemini' } });
      expect(JSON.stringify(pickSeat(report))).not.toContain('claude-opus-5-5');
      expect(report.currentSeat?.reason).toBe('Model is not confirmed in the registry.');
    });
    it('a lane with no known leader command cannot be seated', async () => {
      const s = status(); s.lanes = { constructor: lane(), zai: lane() }; s.budget = { constructor: budget(1), zai: budget(1) };
      const root = await mkdtemp(join(tmpdir(), 'leader-seat-pick-')); roots.push(root);
      await mkdir(join(root, 'queue')); await writeFile(join(root, 'queue/status.json'), JSON.stringify(s));
      await writeFile(join(root, 'models.json'), JSON.stringify({ zai: 'plain-model', constructor: 'plain-model' }));
      const report = await readSeat({ status: () => readFleetRunsDirState({ runsDir: root, now }), models: () => getLaneModelSnapshot({ runsDir: root }),
        registry: async () => [entry('plain-model')], now });
      expect(pickSeat(report).ok).toBe(false);
      expect(report.fallbacks.map(f => [f.lane, f.cli, f.reason])).toEqual([['constructor', null, 'No leader command is known for this lane.'], ['zai', null, 'No leader command is known for this lane.']]);
    });
  });

  describe('leaderSeatCommand and names', () => {
    it('prints claude -p and codex exec with the prompt on stdin, quoting paths', () => {
      expect(leaderSeatCommand({ cli: 'claude', model: 'claude-opus-5-5' }, '/tmp/plan.md').text).toBe('claude -p --model claude-opus-5-5 < /tmp/plan.md');
      expect(leaderSeatCommand({ cli: 'codex', model: 'gpt-6.1-sol' }, "/tmp/my plan's.md").text).toBe(`codex exec --model gpt-6.1-sol - < '/tmp/my plan'\\''s.md'`);
      expect(() => leaderSeatCommand({ cli: 'sh', model: 'x' }, '/tmp/p')).toThrow('No leader command');
      expect(() => leaderSeatCommand({ cli: 'claude', model: '--help' }, '/tmp/p')).toThrow('plain model ID');
    });
    it('names models plainly', () => {
      expect(seatModelName('claude-opus-5-5')).toBe('Opus 5.5');
      expect(seatModelName('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
      expect(seatModelName('gemini-3-pro')).toBe('Gemini 3 Pro');
    expect(seatModelName('plain--model')).toBe('Plain Model'); expect(seatModelName('-')).toBe('-');
    });
  });

  describe('phm leader seat / run --seat auto --dry-run', () => {
    async function cli(args: string[], report: seat.LeaderSeatReport) {
      vi.spyOn(seat, 'readLeaderSeat').mockResolvedValue(report);
      const out: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((v: unknown) => { out.push(String(v)); });
      vi.spyOn(console, 'error').mockImplementation((v: unknown) => { out.push(String(v)); });
      return { code: await runLeaderCli(args), out: out.join('\n') };
    }
    async function promptFile() {
      const root = await mkdtemp(join(tmpdir(), 'leader-prompt-')); roots.push(root);
      const file = join(root, 'plan.md'); await writeFile(file, 'plan the day'); return file;
    }
    it('dry-run prints the exact command with no env values, and never spawns', async () => {
      const file = await promptFile();
      process.env.LEADER_SEAT_FIXTURE_VALUE = 'plainsentinel';
      try {
        const { code, out } = await cli(['run', '--seat', 'auto', '--prompt-file', file, '--dry-run'], await read());
        expect(code).toBe(0);
        expect(out).toBe(`claude -p --model claude-opus-5-5 < ${file}`);
        expect(out).not.toContain('plainsentinel'); expect(out).not.toMatch(/\b[A-Z_]{3,}=/); expect(out).not.toContain('$');
        const json = await cli(['run', '--seat', 'auto', '--prompt-file', file, '--dry-run', '--json'], await read());
        expect(JSON.parse(json.out)).toMatchObject({ schema: 'leader.run.dry-run.v1', seat: { pool: 'claude' },
          command: { argv: ['claude', '-p', '--model', 'claude-opus-5-5'], stdin: file } });
      } finally { delete process.env.LEADER_SEAT_FIXTURE_VALUE; }
    });
    it('exit 3 with a plain reason when no seat qualifies, for seat and run', async () => {
      const s = status(); for (const name of Object.keys(s.lanes)) s.budget[name] = budget(100);
      const report = await read(s), file = await promptFile();
      const run = await cli(['run', '--seat', 'auto', '--prompt-file', file, '--dry-run'], report);
      expect(run).toEqual({ code: 3, out: pickSeat(report).reason });
      expect((await cli(['seat'], report)).code).toBe(3);
      const shown = await cli(['seat'], await read());
      expect(shown.code).toBe(0); expect(shown.out.split('\n')[0]).toBe('Leader: Opus 5.5 on Claude, next: GPT-6.1 Sol on Codex');
    });
    it('--pick prints only the lane and model; exit 3 when nothing is usable', async () => {
      expect(await cli(['seat', '--pick'], await read())).toEqual({ code: 0, out: 'claude claude-opus-5-5' });
      const s = status(); s.budget.claude = budget(100);
      expect(await cli(['seat', '--pick'], await read(s))).toEqual({ code: 0, out: 'codex-personal gpt-6.1-sol' });
      for (const name of Object.keys(s.lanes)) s.budget[name] = budget(100);
      expect((await cli(['seat', '--pick'], await read(s))).code).toBe(3);
      const json = JSON.parse((await cli(['seat', '--json'], await read())).out);
      expect(json).toMatchObject({ schema: 'leader.seat.v1', healthy: true });
    });
    it('refuses a real run, a missing prompt file and other seats', async () => {
      const file = await promptFile(), report = await read();
      expect((await cli(['run', '--seat', 'auto', '--prompt-file', file], report)).code).toBe(2);
      expect((await cli(['run', '--seat', 'auto', '--prompt-file', `${file}.missing`, '--dry-run'], report)).code).toBe(2);
      expect((await cli(['run', '--seat', 'claude', '--prompt-file', file, '--dry-run'], report)).code).toBe(2);
      expect((await cli(['run', '--seat', 'auto', '--dry-run'], report)).code).toBe(2);
    });
  });
});
