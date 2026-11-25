import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'smol-toml';
import { droppedJoinLanes, initOrg, joinOrg, loadOrg, parseQueue, planOrg, readJoins, validateOrg, type JoinRecord } from '../src/core/org/org.js';
import { cmdOrg } from '../src/cli/org.js';
import { buildResourceView } from '../src/core/fabric/resource-view.js';

const example = () => parse(readFileSync('docs/examples/org.toml', 'utf8'));
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'org-')); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const view = (pctUsed: number, hours: number) => buildResourceView({ readings: { 'claude-max': {
  pool: 'claude-max', source: 'claude-max-reader', fetchedAt: new Date(NOW - 60_000).toISOString(), pctUsed,
  resetAt: new Date(NOW + hours * 3_600_000).toISOString() } } }, NOW);
const joined = (member: string, lanes: [string, number][]): JoinRecord => ({ v: 1, member, machine: 'm', lanes: lanes.map(([lane, share]) => ({ lane, share })), joinedAt: '2026-11-09T00:00:00.000Z' });

describe('org.toml validation', () => {
  it('accepts the shipped example', () => {
    const org = validateOrg(example());
    expect(org.members.map((m) => m.id)).toEqual(['mason-wyatt', 'evan-deloria', 'mason-scofield']);
  });
  it('rejects unknown reporting targets, cycles, bad shares and foreign lanes', () => {
    const bad = (mut: (o: any) => void) => { const o = example() as any; mut(o); return () => validateOrg(o); };
    expect(bad((o) => { o.members[1].agents[0].reports_to = 'nobody'; })).toThrow(/unknown/);
    expect(bad((o) => { o.members[0].agents[0].reports_to = 'mason-claude-1'; })).toThrow(/cycle/);
    expect(bad((o) => { o.members[1].contributions[0].share = 101; })).toThrow(/Invalid org/);
    expect(bad((o) => { o.members[1].agents[0].lane = 'codex-personal'; })).toThrow(/not a contribution/);
    expect(bad((o) => { o.leader = 'ghost'; })).toThrow(/not a member/);
  });
  it('refuses secret-shaped metadata without echoing it', () => {
    const o = example() as any; const secret = 'sk-ant-' + 'a'.repeat(30);
    o.members[0].name = secret;
    try { validateOrg(o); throw new Error('no throw'); } catch (e) { expect(String(e)).not.toContain(secret); expect(String(e)).toMatch(/Secret-shaped/); }
  });
  it('loads from a file and reports a missing one plainly', () => {
    expect(() => loadOrg(join(tmp(), 'org.toml'))).toThrow(/No org file/);
    expect(loadOrg('docs/examples/org.toml').leader).toBe('mason-wyatt');
  });
});

describe('init', () => {
  it('writes a starter org.toml that loadOrg accepts, and refuses to overwrite', () => {
    const file = join(tmp(), 'org.toml');
    const r = initOrg({ member: 'ada', machine: 'ada-mac', name: 'Ada', lanes: [{ lane: 'claude', share: 100 }, { lane: 'devin', share: 20 }] }, file);
    expect(r.org.leader).toBe('ada');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# org.toml');
    const loaded = loadOrg(file);
    expect(loaded.leader).toBe('ada');
    expect(loaded.members[0]).toMatchObject({ id: 'ada', name: 'Ada', role: 'founder' });
    expect(loaded.members[0]!.machines.map((m) => m.id)).toEqual(['ada-mac']);
    expect(loaded.members[0]!.contributions).toEqual([{ lane: 'claude', share: 100 }, { lane: 'devin', share: 20 }]);
    expect(() => initOrg({ member: 'grace', machine: 'g-mac', lanes: [] }, file)).toThrow(/already exists/);
    // The refused second init left the first file untouched.
    expect(loadOrg(file).leader).toBe('ada');
  });
  it('validates ids, lanes and names before writing anything', () => {
    const dir = tmp();
    expect(() => initOrg({ member: 'Bad_ID', machine: 'm', lanes: [] }, join(dir, 'a.toml'))).toThrow(/Invalid org/);
    expect(() => initOrg({ member: 'ok', machine: 'm', lanes: [{ lane: 'claude', share: 101 }] }, join(dir, 'b.toml'))).toThrow(/Invalid org/);
    expect(() => initOrg({ member: 'ok', machine: 'm', lanes: [{ lane: 'claude', share: 100 }, { lane: 'claude', share: 50 }] }, join(dir, 'c.toml'))).toThrow(/Duplicate lane/);
    const secret = 'sk-ant-' + 'a'.repeat(30);
    try { initOrg({ member: 'ok', machine: 'm', name: secret, lanes: [] }, join(dir, 'd.toml')); throw new Error('no throw'); }
    catch (e) { expect(String(e)).not.toContain(secret); }
    // Every refused init left nothing behind.
    for (const f of ['a.toml', 'b.toml', 'c.toml', 'd.toml']) expect(existsSync(join(dir, f))).toBe(false);
  });
});

describe('join', () => {
  const org = () => validateOrg(example());
  it('opts in only named lanes, lowers but never raises a share, and holds no credentials', () => {
    const dir = tmp();
    const r = joinOrg(org(), { member: 'evan-deloria', machine: 'evan-mac', optIn: [{ lane: 'claude', share: 10 }] }, { dir });
    expect(r.lanes).toEqual([{ lane: 'claude', share: 10 }]);
    expect(readJoins(dir)).toHaveLength(1);
    expect(() => joinOrg(org(), { member: 'evan-deloria', machine: 'evan-mac', optIn: [{ lane: 'claude', share: 31 }] }, { dir })).toThrow(/declared 30/);
    expect(() => joinOrg(org(), { member: 'evan-deloria', machine: 'evan-mac', optIn: [{ lane: 'devin' }] }, { dir })).toThrow(/does not declare/);
    expect(joinOrg(org(), { member: 'evan-deloria', machine: 'evan-mac', optIn: [] }, { dir }).lanes).toEqual([]);
  });
  it('refuses a machine whose declared host is not this host', () => {
    const o = example() as any; o.members[1].machines[0].host = 'evans-macbook.local';
    expect(() => joinOrg(validateOrg(o), { member: 'evan-deloria', machine: 'evan-mac', optIn: [] }, { dir: tmp(), host: 'other' })).toThrow(/not that machine/);
    expect(joinOrg(validateOrg(o), { member: 'evan-deloria', machine: 'evan-mac', optIn: [] }, { dir: tmp(), host: 'Evans-MacBook' }).member).toBe('evan-deloria');
  });
  it('replaces the whole record and names the lanes a re-join dropped', () => {
    const dir = tmp();
    const o = org();
    const first = joinOrg(o, { member: 'mason-wyatt', machine: 'mason-mac', optIn: [{ lane: 'claude' }, { lane: 'codex-personal', share: 40 }] }, { dir });
    // A first join drops nothing; lowering a share is not a drop.
    expect(droppedJoinLanes(undefined, first)).toEqual([]);
    const second = joinOrg(o, { member: 'mason-wyatt', machine: 'mason-mac', optIn: [{ lane: 'claude', share: 50 }] }, { dir });
    expect(second.lanes).toEqual([{ lane: 'claude', share: 50 }]);
    expect(droppedJoinLanes(first, second)).toEqual([{ lane: 'codex-personal', share: 40 }]);
    // Naming the lane again restores it; an identical re-join drops nothing.
    const third = joinOrg(o, { member: 'mason-wyatt', machine: 'mason-mac', optIn: [{ lane: 'claude' }, { lane: 'codex-personal' }] }, { dir });
    expect(droppedJoinLanes(second, third)).toEqual([]);
    expect(droppedJoinLanes(third, third)).toEqual([]);
  });
});

describe('plan', () => {
  const org = validateOrg(example());
  const now = new Date(NOW);
  const jobs = (n: number, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: `J${i}`, ...extra }));

  it('holds lanes nobody opted into and assigns nothing there', () => {
    const p = planOrg(org, [], view(10, 1), jobs(2), now);
    expect(p.assignments).toEqual([]);
    expect(p.held.map((h) => `${h.member}/${h.lane}`)).toContain('evan-deloria/claude');
    expect(p.unassigned[0]!.reason).toMatch(/budget/);
  });
  it('never exceeds a member contributed budget', () => {
    const p = planOrg(org, [joined('evan-deloria', [['claude', 30]])], null, jobs(10, { costPct: 2 }), now);
    // unknown usage: 25 points of headroom x 30% share = 7.5 points, so 3 jobs at 2 points
    expect(p.assignments).toHaveLength(3);
    expect(p.budgets[0]).toMatchObject({ usage: 'unknown', budgetPct: 7.5 });
    expect(p.unassigned).toHaveLength(7);
  });
  it('gives a red pool no budget and uses reset urgency for known pools', () => {
    const red = planOrg(org, [joined('mason-wyatt', [['claude', 100]])], view(100, 2), jobs(1), now);
    expect(red.assignments).toEqual([]);
    const soon = planOrg(org, [joined('mason-wyatt', [['claude', 100]])], view(50, 1), jobs(1), now).budgets[0]!;
    const late = planOrg(org, [joined('mason-wyatt', [['claude', 100]])], view(50, 100), jobs(1), now).budgets[0]!;
    expect(soon.urgency).toBeGreaterThan(late.urgency);
    expect(soon).toMatchObject({ usage: 'known', headroomPct: 50, budgetPct: 50 });
  });
  it('orders by priority per cost, honours pinned lanes and spreads across agents', () => {
    const q = [{ id: 'cheap', priority: 1, costPct: 1 }, { id: 'big', priority: 1, costPct: 50 }, { id: 'pinned', lane: 'codex-personal', priority: 5 }];
    const p = planOrg(org, [joined('mason-wyatt', [['claude', 100], ['codex-personal', 100]])], view(0, 10), q, now);
    expect(p.assignments[0]!.job).toBe('pinned');
    expect(p.assignments.find((a) => a.job === 'pinned')).toMatchObject({ agent: 'mason-codex-1', lane: 'codex-personal' });
    expect(p.assignments.map((a) => a.job)).toContain('big');
  });
  it('proposes roles with reporting lines, one reviewer per multi-agent lane', () => {
    const p = planOrg(org, [joined('mason-wyatt', [['claude', 100]])], null, [], now);
    const by = Object.fromEntries(p.roles.map((r) => [r.agent, r]));
    expect(by['leader']).toMatchObject({ role: 'leader', reportsTo: null });
    expect(by['mason-claude-1']).toMatchObject({ role: 'implementer', reportsTo: 'leader' });
    expect(by['mason-claude-2']!.role).toBe('reviewer');
    expect(by['mason-codex-1']).toBeUndefined();
  });
  it('rejects secret-shaped queues and malformed entries', () => {
    expect(() => parseQueue(JSON.stringify([{ id: 'x', title: 'ghp_' + 'a'.repeat(36) }]))).toThrow(/Secret-shaped/);
    expect(() => parseQueue('[{"id":"x","extra":1}]')).toThrow(/Queue entries/);
  });
});

describe('cmdOrg', () => {
  it('show and plan emit JSON; join writes under ASHLR_HOME only', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const out: string[] = []; vi.spyOn(console, 'log').mockImplementation((s) => { out.push(String(s)); });
    expect(await cmdOrg(['show', '--file', 'docs/examples/org.toml', '--json'])).toBe(0);
    expect(JSON.parse(out.pop()!).schema).toBe('org.show.v1');
    expect(await cmdOrg(['join', '--file', 'docs/examples/org.toml', '--member', 'mason-scofield', '--machine', 'sco-mac', '--lane', 'codex-personal=20', '--json'])).toBe(0);
    expect(JSON.parse(out.pop()!).record.lanes).toEqual([{ lane: 'codex-personal', share: 20 }]);
    expect(await cmdOrg(['plan', '--file', 'docs/examples/org.toml', '--json'])).toBe(0);
    const plan = JSON.parse(out.pop()!);
    expect(plan.schema).toBe('org.plan.v1');
    expect(plan.budgets.map((b: any) => b.member)).toEqual(['mason-scofield']);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdOrg(['bogus'])).toBe(2);
    expect(await cmdOrg(['--help'])).toBe(0);
    vi.unstubAllEnvs();
  });

  it('join reports the lanes a re-join dropped, in JSON and text', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    const file = 'docs/examples/org.toml';
    const base = ['join', '--file', file, '--member', 'mason-wyatt', '--machine', 'mason-mac'];
    // First join: nothing to drop.
    expect(await cmdOrg([...base, '--lane', 'claude', '--lane', 'codex-personal=40', '--json'])).toBe(0);
    expect(JSON.parse(logs.pop()!).droppedLanes).toEqual([]);
    // Re-join naming only claude replaces the record; codex-personal is reported dropped.
    expect(await cmdOrg([...base, '--lane', 'claude=50', '--json'])).toBe(0);
    const second = JSON.parse(logs.pop()!);
    expect(second.schema).toBe('org.join.v1');
    expect(second.record.lanes).toEqual([{ lane: 'claude', share: 50 }]);
    expect(second.droppedLanes).toEqual([{ lane: 'codex-personal', share: 40 }]);
    // Text mode names the dropped lane and how to restore it.
    expect(await cmdOrg([...base, '--lane', 'claude=50', '--lane', 'codex-personal=10'])).toBe(0);
    const restore = logs.pop()!;
    expect(restore).not.toContain('no longer opts in');
    expect(await cmdOrg([...base, '--lane', 'claude=50'])).toBe(0);
    const text = logs.pop()!;
    expect(text).toContain('no longer opts in: codex-personal (was 10%)');
    expect(text).toContain('Name the lane again with --lane to restore it.');
    vi.unstubAllEnvs();
  });

  it('refuses malformed arguments instead of silently ignoring them', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [], errs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    vi.spyOn(console, 'error').mockImplementation((s) => { errs.push(String(s)); });
    const file = 'docs/examples/org.toml';
    const base = ['join', '--file', file, '--member', 'evan-deloria', '--machine', 'evan-mac'];
    // A valid join lands its record; every refused invocation must leave it untouched.
    expect(await cmdOrg([...base, '--lane', 'claude=20', '--json'])).toBe(0);
    const joined = readJoins();
    expect(joined).toHaveLength(1);
    expect(JSON.parse(logs.pop()!).recordFile).toBe(join(home, 'org', 'joins', 'evan-deloria.evan-mac.json'));
    const malformed: [string[], string][] = [
      [[...base, 'claude', '--json'], 'Unexpected argument'],                  // stray positional reads as "no lanes" otherwise
      [[...base, '--bogus', '--json'], 'Unexpected argument'],                 // unknown flag
      [[...base, '--member', 'mason-wyatt', '--json'], 'more than once'],      // repeated single-value flag
      [[...base, '--lane', '--json'], '--lane needs a value'],                 // --lane with no value
      [[...base, '--lane', 'claude=20=30', '--json'], '--lane takes <lane> or <lane>=<share>'], // second '='
      [[...base, '--lane', 'claude=', '--json'], '--lane share must be a number'], // empty share is not share 0
      [[...base, '--lane', '=20', '--json'], '--lane needs a lane name'],      // empty lane name
      [[...base, '--lane', 'claude=abc', '--json'], '--lane share must be a number'], // non-numeric share
      [[...base, '--lane', 'claude=10', '--lane', 'claude=20', '--json'], 'more than once'], // same lane twice
      [['join', '--file', file, '--member', '--machine', 'evan-mac', '--json'], '--member needs a value'], // flag as value
      [['show', '--file', file, '--file', file, '--json'], '--file was given more than once'],
      [['show', '--file', file, 'stray', '--json'], 'Unexpected argument'],
      [['plan', '--file', file, 'stray', '--json'], 'Unexpected argument'],
      [['plan', '--file', file, '--queue', 'a', '--queue', 'b', '--json'], '--queue was given more than once'],
    ];
    for (const [args, said] of malformed) {
      expect(await cmdOrg(args), args.join(' ')).toBe(1);
      // --json callers get the org.error.v1 envelope on stdout, never stderr text.
      const failure = JSON.parse(logs.pop()!);
      expect(failure.schema).toBe('org.error.v1');
      // Failures before the verb is known report command "org"; later ones name it.
      expect(['org', 'show', 'join', 'plan']).toContain(failure.command);
      expect(failure.error.code).toBe('rejected');
      expect(failure.error.message).toContain(said);
    }
    expect(readJoins()).toEqual(joined);
    expect(errs).toEqual([]);
    // The same refusal without --json stays human text on stderr.
    expect(await cmdOrg([...base, 'claude'])).toBe(1);
    const said = errs.join('\n');
    expect(said).toContain('Unexpected argument');
    expect(said).toContain('Run: phm org --help');
    // Distinct lanes in one join still work; --lane without '=' keeps the declared share.
    expect(await cmdOrg(['join', '--file', file, '--member', 'mason-wyatt', '--machine', 'mason-mac',
      '--lane', 'claude', '--lane', 'codex-personal=50', '--json'])).toBe(0);
    expect(JSON.parse(logs.pop()!).record.lanes).toEqual([{ lane: 'claude', share: 100 }, { lane: 'codex-personal', share: 50 }]);
    // Text mode names the record file the member sends to the leader.
    expect(await cmdOrg(['join', '--file', file, '--member', 'mason-wyatt', '--machine', 'mason-mac', '--lane', 'claude=10'])).toBe(0);
    const text = logs.pop()!;
    expect(text).toContain(`Record: ${join(home, 'org', 'joins', 'mason-wyatt.mason-mac.json')}`);
    vi.unstubAllEnvs();
  });

  it('init writes org.toml, feeds show/join, refuses overwrite and bad flags', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [], errs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    vi.spyOn(console, 'error').mockImplementation((s) => { errs.push(String(s)); });
    const file = join(home, 'org.toml');
    expect(await cmdOrg(['init', '--member', 'ada', '--machine', 'ada-mac', '--name', 'Ada', '--lane', 'claude', '--lane', 'devin=20', '--json'])).toBe(0);
    const init = JSON.parse(logs.pop()!);
    expect(init).toMatchObject({ schema: 'org.init.v1', file, leader: 'ada', member: 'ada', machine: 'ada-mac' });
    expect(init.lanes).toEqual([{ lane: 'claude', share: 100 }, { lane: 'devin', share: 20 }]);
    // The written file is a valid org the other verbs accept.
    expect(await cmdOrg(['show', '--file', file, '--json'])).toBe(0);
    expect(JSON.parse(logs.pop()!).org.leader).toBe('ada');
    expect(await cmdOrg(['join', '--file', file, '--member', 'ada', '--machine', 'ada-mac', '--lane', 'claude', '--json'])).toBe(0);
    expect(JSON.parse(logs.pop()!).record.lanes).toEqual([{ lane: 'claude', share: 100 }]);
    // init never overwrites; --file targets another path and text mode names next steps.
    expect(await cmdOrg(['init', '--member', 'grace', '--machine', 'g-mac', '--json'])).toBe(1);
    expect(JSON.parse(logs.pop()!).error.message).toContain('already exists');
    const other = join(home, 'other.toml');
    expect(await cmdOrg(['init', '--file', other, '--member', 'grace', '--machine', 'g-mac'])).toBe(0);
    const text = logs.pop()!;
    expect(text).toContain(`Wrote ${other}`);
    expect(text).toContain('phm org join --member grace --machine g-mac --json');
    expect(text).toContain('phm org plan --json');
    expect(errs).toEqual([]);
    vi.unstubAllEnvs();
  });

  it('refuses malformed init arguments with the org envelope', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    const malformed: [string[], string][] = [
      [['init', '--json'], 'init needs --member and --machine'],
      [['init', '--member', 'ada', '--json'], 'init needs --member and --machine'],
      [['init', '--member', 'ada', '--machine', 'm', '--lane', 'claude=20=30', '--json'], '--lane takes <lane> or <lane>=<share>'],
      [['init', '--member', 'ada', '--machine', 'm', '--lane', '=20', '--json'], '--lane needs a lane name'],
      [['init', '--member', 'ada', '--machine', 'm', '--lane', 'claude=', '--json'], '--lane share must be a number'],
      [['init', '--member', 'ada', '--machine', 'm', '--lane', 'claude=abc', '--json'], '--lane share must be a number'],
      [['init', '--member', 'ada', '--machine', 'm', '--lane', 'claude=101', '--json'], '--lane share must be a number'],
      [['init', '--member', 'ada', '--machine', 'm', '--lane', 'claude', '--lane', 'claude=20', '--json'], 'more than once'],
      [['init', '--member', 'ada', '--machine', 'm', 'stray', '--json'], 'Unexpected argument'],
      [['init', '--member', '--machine', 'm', '--json'], '--member needs a value'],
      [['init', '--member', 'Bad_ID', '--machine', 'm', '--json'], 'Invalid org'],
    ];
    for (const [args, said] of malformed) {
      expect(await cmdOrg(args), args.join(' ')).toBe(1);
      const failure = JSON.parse(logs.pop()!);
      expect(failure).toMatchObject({ schema: 'org.error.v1', command: 'init', error: { code: 'rejected' } });
      expect(failure.error.message).toContain(said);
    }
    // Nothing was written by any refused init.
    expect(existsSync(join(home, 'org.toml'))).toBe(false);
    vi.unstubAllEnvs();
  });

  it('emits org.error.v1 under --json: usage exits 2, refusals and operational failures exit 1', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [], errs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    vi.spyOn(console, 'error').mockImplementation((s) => { errs.push(String(s)); });
    const popped = () => JSON.parse(logs.pop()!);
    // Unknown verb and malformed bare-org arguments are usage errors (exit 2).
    expect(await cmdOrg(['bogus', '--json'])).toBe(2);
    expect(popped()).toMatchObject({ schema: 'org.error.v1', command: 'org', error: { code: 'usage' } });
    expect(await cmdOrg(['--bogus', '--json'])).toBe(2);
    expect(popped()).toMatchObject({ schema: 'org.error.v1', command: 'org', error: { code: 'usage' } });
    // A missing org file is the org model refusing the request (exit 1, rejected).
    const missing = join(home, 'missing.toml');
    expect(await cmdOrg(['show', '--file', missing, '--json'])).toBe(1);
    expect(popped()).toMatchObject({ schema: 'org.error.v1', command: 'show',
      error: { code: 'rejected', message: expect.stringContaining('No org file') } });
    // An unreadable queue file is operational, not a refusal (exit 1, error).
    expect(await cmdOrg(['plan', '--file', 'docs/examples/org.toml', '--queue', join(home, 'nope.json'), '--json'])).toBe(1);
    expect(popped()).toMatchObject({ schema: 'org.error.v1', command: 'plan', error: { code: 'error' } });
    // Text mode is unchanged: the same failure is stderr text, stdout stays clean.
    expect(await cmdOrg(['show', '--file', missing])).toBe(1);
    expect(errs.join('\n')).toContain(`phm org: No org file at ${missing}`);
    expect(logs).toEqual([]);
    vi.unstubAllEnvs();
  });
});
