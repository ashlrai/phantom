import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { filterSeatHandoffsPlan, planSeatHandoffs, type QuotaEvidence, type SeatHandoffsFilter, type SeatOptions } from '../src/core/bots/seats.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { runBotsCli } from '../src/cli/bots.js';

const homes: string[] = [];
const now = Date.parse('2026-11-18T12:00:00Z');
const iso = (n = now) => new Date(n).toISOString();
const unknown: QuotaEvidence = { status: 'unknown', reason: 'missing-key', asOf: null };
const devinSeat = () => ({ id: 'helper', kind: 'devin-bot', displayName: 'Helper', participantId: 'helper', capabilities: ['code'], secretHandle: 'phm_devin_api_key', quota: { source: 'none' } });
const localSeat = (id: string, participantId = id) => ({ id, kind: 'local', displayName: id, participantId, capabilities: ['review'], quota: { source: 'none' } });

/**
 * Three-seat roster exercising every filter dimension: `helper` drains with
 * two pending claims, `rev-bot` (seat id `reviewer`, a distinct participant
 * label) stays active and ineligible, `idler` is eligible through handoff
 * history with nothing pending.
 */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'bot-seat-filters-')); homes.push(home);
  const root = join(home, '.phantom', 'bots');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'seats.json'), JSON.stringify({ schema: 'phantom-bot-seats.v1',
    seats: [devinSeat(), localSeat('reviewer', 'rev-bot'), localSeat('idler')] }));
  const fleetRoot = join(home, '.ashlr', 'fleet');
  // Claims lease against the real clock: the CLI reads plans at Date.now()
  // while the core tests inject the frozen `now` — liveness is only an
  // upper bound (`now < leaseUntil`), so a real-time lease stays live under
  // both reads.
  const claim = (key: string, owner: string, sourceId: string) => {
    const realNow = Date.now();
    expect(acquireCoordination({ root: fleetRoot, origin: 'resource', key, owner, sourceId,
      leaseMs: 3_600_000, leaseUntil: realNow + 3_600_000, now: realNow }).status).toBe('acquired');
  };
  claim('pr:o/r#20', 'helper', 'helper-claim-one');
  claim('pr:o/r#21', 'helper', 'helper-claim-two');
  claim('pr:o/r#22', 'rev-bot', 'reviewer-claim');
  await writeFile(join(root, 'seat-state.json'), JSON.stringify({
    helper: { state: 'draining', since: iso(), exhaustedReset: null },
    reviewer: { state: 'active', since: iso(), exhaustedReset: null },
    idler: { state: 'idle', since: iso(), exhaustedReset: null },
  }));
  // idler is eligible only through prior handoff history: apply retries its unfinished notices.
  await writeFile(join(root, 'handoffs.jsonl'), JSON.stringify({ schema: 'phantom-bot-handoff.v1',
    handoffId: 'old-handoff', seatId: 'idler', work: { kind: 'bus-claim', ref: 'pr:o/r#9' },
    done: 'unknown', left: 'unknown', branch: null, pr: null, createdAt: iso() }) + '\n');
  const o: SeatOptions = { home, now: () => now, runs: join(home, 'runs'), readQuota: async () => unknown };
  return { home, root, o };
}
afterEach(async () => { await Promise.all(homes.splice(0).map(h => rm(h, { recursive: true, force: true }))); });

const seatIds = (plan: { seats: { seatId: string }[] }) => plan.seats.map(s => s.seatId);

it('narrows the fleet handoff plan by seat id and participant label', async () => {
  const { o } = await fixture();
  const plan = await planSeatHandoffs(o);
  expect(seatIds(plan)).toEqual(['helper', 'reviewer', 'idler']);
  // --seat matches the config seat id or the bus participant label exactly.
  expect(seatIds(filterSeatHandoffsPlan(plan, { seat: 'helper' }))).toEqual(['helper']);
  expect(seatIds(filterSeatHandoffsPlan(plan, { seat: 'rev-bot' }))).toEqual(['reviewer']);
  expect(seatIds(filterSeatHandoffsPlan(plan, { seat: 'missing' }))).toEqual([]);
});

it('narrows by lifecycle state and eligibility verdict', async () => {
  const { o } = await fixture();
  const plan = await planSeatHandoffs(o);
  expect(seatIds(filterSeatHandoffsPlan(plan, { state: 'draining' }))).toEqual(['helper']);
  expect(seatIds(filterSeatHandoffsPlan(plan, { state: 'idle' }))).toEqual(['idler']);
  expect(seatIds(filterSeatHandoffsPlan(plan, { state: 'active' }))).toEqual(['reviewer']);
  expect(seatIds(filterSeatHandoffsPlan(plan, { eligible: true }))).toEqual(['helper', 'idler']);
  expect(seatIds(filterSeatHandoffsPlan(plan, { eligible: false }))).toEqual(['reviewer']);
});

it('narrows by pending work and contains over held-work text', async () => {
  const { o } = await fixture();
  const plan = await planSeatHandoffs(o);
  // Only eligible seats carry records, so --pending is the "what would move" slice.
  expect(seatIds(filterSeatHandoffsPlan(plan, { pending: true }))).toEqual(['helper']);
  expect(seatIds(filterSeatHandoffsPlan(plan, { pending: false }))).toEqual(['reviewer', 'idler']);
  // --contains is record-level: helper keeps only the matching claim, seats
  // left with no matching record drop out entirely.
  const narrowed = filterSeatHandoffsPlan(plan, { contains: 'O/R#20' });
  expect(narrowed.seats).toHaveLength(1);
  expect(narrowed.seats[0]).toMatchObject({ seatId: 'helper' });
  expect(narrowed.seats[0]!.handoffs.map(h => h.work.ref)).toEqual(['pr:o/r#20']);
  expect(seatIds(filterSeatHandoffsPlan(plan, { contains: 'nothing-matches' }))).toEqual([]);
  // pending composes after contains: a seat whose only records miss the
  // needle is not pending for this query.
  expect(seatIds(filterSeatHandoffsPlan(plan, { contains: 'o/r#20', pending: true }))).toEqual(['helper']);
  expect(seatIds(filterSeatHandoffsPlan(plan, { contains: 'o/r#20', state: 'idle' }))).toEqual([]);
});

it('echoes the applied filter and treats an empty filter as the whole roster', async () => {
  const { o } = await fixture();
  const plan = await planSeatHandoffs(o);
  const whole = filterSeatHandoffsPlan(plan, {});
  expect(whole).toEqual(plan);
  expect(whole.filter).toBeUndefined();
  const filtered = filterSeatHandoffsPlan(plan, { seat: 'helper', contains: '  PR:O/R#21  ' } satisfies SeatHandoffsFilter);
  expect(filtered.filter).toEqual({ seat: 'helper', contains: 'pr:o/r#21' });
  expect(filtered.seats[0]!.handoffs.map(h => h.work.ref)).toEqual(['pr:o/r#21']);
  // A needle that normalizes to nothing is no predicate: no filter echo.
  const blank = filterSeatHandoffsPlan(plan, { contains: '   ' });
  expect(blank.filter).toBeUndefined();
  expect(seatIds(blank)).toEqual(['helper', 'reviewer', 'idler']);
});

it('CLI handoffs honors the read filters and refuses them under --apply', async () => {
  const { home, root } = await fixture();
  const out: string[] = [], emit = (text: string) => out.push(text);
  const run = async (args: string[]) => {
    out.length = 0;
    const code = await runBotsCli(['handoffs', ...args, '--json'], emit, home);
    return { code, body: JSON.parse(out.pop()!) };
  };
  // --seat was accepted but silently ignored before; now it narrows the plan.
  let result = await run(['--seat', 'rev-bot']);
  expect(result.code).toBe(0);
  expect(seatIds(result.body)).toEqual(['reviewer']);
  expect(result.body.filter).toEqual({ seat: 'rev-bot' });
  result = await run(['--state', 'idle']);
  expect(seatIds(result.body)).toEqual(['idler']);
  result = await run(['--ineligible']);
  expect(seatIds(result.body)).toEqual(['reviewer']);
  expect(result.body.filter).toEqual({ eligible: false });
  result = await run(['--pending', '--contains', 'o/r#21']);
  expect(result.body.seats).toHaveLength(1);
  expect(result.body.seats[0].handoffs.map((h: { work: { ref: string } }) => h.work.ref)).toEqual(['pr:o/r#21']);
  // No match is an honestly empty filtered view, not an error.
  result = await run(['--seat', 'missing']);
  expect(result.code).toBe(0);
  expect(result.body.seats).toEqual([]);
  expect(result.body.filter).toEqual({ seat: 'missing' });
  // Filters are read-only: they never combine with the fleet apply.
  for (const args of [['--apply', '--seat', 'helper'], ['--apply', '--state', 'idle'], ['--apply', '--pending'], ['--apply', '--contains', 'x']]) {
    result = await run(args);
    expect(result.code).toBe(1);
    expect(result.body.ok).toBe(false);
    expect(result.body.error).toContain('--apply');
  }
  // Invalid values and the contradictory pair fail before any store read.
  for (const args of [['--state', 'bogus'], ['--eligible', '--ineligible'], ['--contains', ''], ['--contains', 'x'.repeat(513)]]) {
    result = await run(args);
    expect(result.code).toBe(1);
    expect(result.body.ok).toBe(false);
  }
  // The unfiltered read is unchanged and still writes nothing.
  result = await run([]);
  expect(result.code).toBe(0);
  expect(seatIds(result.body)).toEqual(['helper', 'reviewer', 'idler']);
  expect(result.body.filter).toBeUndefined();
  expect((await readdir(root)).sort()).toEqual(['handoffs.jsonl', 'seat-state.json', 'seats.json']);
});

it('keeps the read filters off the other bots verbs', async () => {
  const { home } = await fixture();
  const out: string[] = [], emit = (text: string) => out.push(text);
  // seats cannot apply a handoff filter — the flag is an invalid option, not
  // a silently ignored one.
  expect(await runBotsCli(['seats', '--pending', '--json'], emit, home)).toBe(1);
  expect(JSON.parse(out.pop()!).error).toBe('Invalid option: --pending');
  expect(await runBotsCli(['handoff', '--seat', 'helper', '--contains', 'x'], emit, home)).toBe(1);
  expect(JSON.parse(out.pop()!).error).toBe('Invalid option: --contains');
});
