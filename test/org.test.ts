import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const joined = (member: string, lanes: [string, number][], machine = 'm'): JoinRecord => ({ v: 1, member, machine, lanes: lanes.map(([lane, share]) => ({ lane, share })), joinedAt: '2026-11-09T00:00:00.000Z' });

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
  it('names the line of a malformed org.toml and points at the leader', () => {
    const file = join(tmp(), 'org.toml');
    writeFileSync(file, 'version = 1\nleader = "boss"\n[[members]]\nid = "a"\nbad line here\n');
    // A member cannot repair org.toml — the leader owns it — so the refusal
    // names the broken line for the report back, never echoes file content.
    let message = '';
    try { loadOrg(file); } catch (e) { message = String(e); }
    expect(message).toMatch(/not valid TOML at line 5\./);
    expect(message).toMatch(/org leader/);
    expect(message).not.toContain('bad line here');
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
  it('writes declared agents as implementers on the init machine reporting to the founder', () => {
    const file = join(tmp(), 'org.toml');
    const r = initOrg({ member: 'ada', machine: 'ada-mac', lanes: [{ lane: 'claude', share: 100 }, { lane: 'devin', share: 50 }],
      agents: [{ id: 'ada-claude', lane: 'claude' }, { id: 'ada-devin', lane: 'devin' }] }, file);
    expect(r.org.members[0]!.agents).toEqual([
      { id: 'ada-claude', lane: 'claude', machine: 'ada-mac', roles: ['implementer'], reports_to: 'ada' },
      { id: 'ada-devin', lane: 'devin', machine: 'ada-mac', roles: ['implementer'], reports_to: 'ada' },
    ]);
    // The file round-trips: loadOrg accepts what init wrote.
    expect(loadOrg(file).members[0]!.agents).toHaveLength(2);
    // An agent on a lane the member never declared, a repeated agent id and an
    // agent id colliding with the member id are all refused before anything is written.
    const dir = tmp();
    expect(() => initOrg({ member: 'ok', machine: 'm', lanes: [{ lane: 'claude', share: 100 }],
      agents: [{ id: 'a1', lane: 'devin' }] }, join(dir, 'a.toml'))).toThrow(/not a contribution/);
    expect(() => initOrg({ member: 'ok', machine: 'm', lanes: [{ lane: 'claude', share: 100 }],
      agents: [{ id: 'a1', lane: 'claude' }, { id: 'a1', lane: 'claude' }] }, join(dir, 'b.toml'))).toThrow(/Duplicate id/);
    expect(() => initOrg({ member: 'ok', machine: 'm', lanes: [{ lane: 'claude', share: 100 }],
      agents: [{ id: 'ok', lane: 'claude' }] }, join(dir, 'c.toml'))).toThrow(/Duplicate id/);
    for (const f of ['a.toml', 'b.toml', 'c.toml']) expect(existsSync(join(dir, f))).toBe(false);
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
  it('names the way through a host mismatch: the sibling machine this host matches, else the leader fix', () => {
    const o = example() as any;
    o.members[1].machines = [
      { id: 'evan-mac', host: 'evans-macbook.local' },
      { id: 'evan-laptop', host: 'evans-laptop.local' },
    ];
    const org = validateOrg(o);
    // On the laptop but asking for the mac: the refusal names the laptop's id.
    expect(() => joinOrg(org, { member: 'evan-deloria', machine: 'evan-mac', optIn: [] }, { dir: tmp(), host: 'Evans-Laptop' }))
      .toThrow(/Run join on evans-macbook\.local; this is not that machine\. This computer matches declared machine evan-laptop: run phm org join --member evan-deloria --machine evan-laptop\./);
    // On a host no declared machine names (renamed or replaced computer): the leader re-points it.
    expect(() => joinOrg(org, { member: 'evan-deloria', machine: 'evan-mac', optIn: [] }, { dir: tmp(), host: 'stranger' }))
      .toThrow(/not that machine\. If this computer replaced it or was renamed, ask the leader to update the machine's host in org\.toml\./);
    // Two siblings matching this host is ambiguous: no machine is guessed.
    const both = example() as any;
    both.members[1].machines = [
      { id: 'evan-mac', host: 'evans-macbook.local' },
      { id: 'evan-laptop', host: 'EVANS-MACBOOK' },
      { id: 'evan-tower', host: 'tower.local' },
    ];
    expect(() => joinOrg(validateOrg(both), { member: 'evan-deloria', machine: 'evan-tower', optIn: [] }, { dir: tmp(), host: 'evans-macbook' }))
      .toThrow(/not that machine\. If this computer replaced it or was renamed/);
    // A sibling without a declared host never counts as a match.
    const open = example() as any;
    open.members[1].machines = [
      { id: 'evan-mac', host: 'evans-macbook.local' },
      { id: 'evan-laptop' },
    ];
    expect(() => joinOrg(validateOrg(open), { member: 'evan-deloria', machine: 'evan-mac', optIn: [] }, { dir: tmp(), host: 'evans-laptop' }))
      .toThrow(/not that machine\. If this computer replaced it or was renamed/);
  });
  it('names the declared ids and the leader fix on identity refusals', () => {
    const dir = tmp();
    const o = org();
    // A member id missing from org.toml lists who is declared and who adds one.
    expect(() => joinOrg(o, { member: 'ghost', machine: 'm', optIn: [] }, { dir }))
      .toThrow(/Unknown member ghost\. This org\.toml declares: mason-wyatt, evan-deloria, mason-scofield\. If yours is missing, ask the leader to add it to org\.toml before join\./);
    // An undeclared machine names the member's machines and both ways forward.
    expect(() => joinOrg(o, { member: 'evan-deloria', machine: 'evan-laptop', optIn: [] }, { dir }))
      .toThrow(/evan-laptop is not a declared machine of evan-deloria\. Declared machines: evan-mac\. Pick a declared id, or ask the leader to add this machine to org\.toml\./);
    // An undeclared lane names the member's lanes the same way.
    expect(() => joinOrg(o, { member: 'evan-deloria', machine: 'evan-mac', optIn: [{ lane: 'devin' }] }, { dir }))
      .toThrow(/does not declare lane devin\. Declared lanes: claude\. Pick a declared lane, or ask the leader to add the contribution in org\.toml\./);
    // Members with nothing declared say "none", never an empty list.
    const bare = example() as any;
    bare.members.push({ id: 'newbie', name: 'New', role: 'member', machines: [{ id: 'n-mac' }], contributions: [] });
    const o2 = validateOrg(bare);
    expect(() => joinOrg(o2, { member: 'newbie', machine: 'n-mac', optIn: [{ lane: 'claude' }] }, { dir }))
      .toThrow(/Declared lanes: none/);
    bare.members[3].machines = [];
    const o3 = validateOrg(bare);
    expect(() => joinOrg(o3, { member: 'newbie', machine: 'n-mac', optIn: [] }, { dir }))
      .toThrow(/Declared machines: none/);
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

  it('consumes each known resource-plan slot once without treating unknown as zero', () => {
    const joins = [joined('mason-wyatt', [['claude', 100]])];
    const input = jobs(2, { lane: 'claude' });
    const plan = planOrg(org, joins, view(0, 10), input, now, [{ lane: 'claude', additional_slots: 1 }]);
    expect(plan.assignments.map(row => row.job)).toEqual(['J0']);
    expect(plan.unassigned).toEqual([{ job: 'J1', reason: 'no resource-plan slots left' }]);
    expect(planOrg(org, joins, view(0, 10), input, now, [{ lane: 'claude', additional_slots: null }]).assignments).toHaveLength(2);
  });

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
  it('budgets a multi-machine lane at the largest committed share, never record order', () => {
    // mason-mac offers claude=30 and mason-mac-2 offers claude=90. Both offers
    // draw on the member's one declared claude pool, so they do not add up:
    // the member's ceiling is 90 and the plan must say so whichever join
    // record comes first. Unknown usage: 25 points of headroom x 90% = 22.5.
    const lowFirst = [joined('mason-wyatt', [['claude', 30]], 'mason-mac'), joined('mason-wyatt', [['claude', 90]], 'mason-mac-2')];
    const highFirst = [...lowFirst].reverse();
    for (const joins of [lowFirst, highFirst]) {
      const p = planOrg(org, joins, null, [{ id: 'J1', priority: 5, costPct: 20, lane: 'claude' }], now);
      expect(p.budgets.find((b) => b.member === 'mason-wyatt' && b.lane === 'claude')).toMatchObject({ share: 90, budgetPct: 22.5 });
      expect(p.assignments).toHaveLength(1);
      expect(p.unassigned).toEqual([]);
    }
    // A zero-share machine beside a real offer does not hold the lane.
    const mixed = [joined('mason-wyatt', [['claude', 0]], 'mason-mac'), joined('mason-wyatt', [['claude', 40]], 'mason-mac-2')];
    const p = planOrg(org, mixed, null, [], now);
    expect(p.held.map((h) => `${h.member}/${h.lane}`)).not.toContain('mason-wyatt/claude');
    expect(p.budgets.find((b) => b.member === 'mason-wyatt' && b.lane === 'claude')).toMatchObject({ share: 40 });
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
  it('names the missing implementer agent on a fresh org instead of blaming budget', () => {
    // `phm org init` declares lanes but no agents; an opted-in machine then has
    // budget left and still cannot take work. The unassigned reason must name
    // the real blocker — the first-run case this plan exists to explain.
    const { org: fresh } = initOrg({ member: 'ada', machine: 'ada-mac', lanes: [{ lane: 'claude', share: 100 }] }, join(tmp(), 'org.toml'));
    const p = planOrg(fresh, [joined('ada', [['claude', 100]])], null, jobs(2, { lane: 'claude' }), now);
    expect(p.assignments).toEqual([]);
    expect(p.budgets[0]).toMatchObject({ member: 'ada', lane: 'claude', budgetPct: 25 });
    expect(p.unassigned).toHaveLength(2);
    for (const u of p.unassigned) {
      expect(u.reason).toBe('no implementer agent declared on ada/claude');
      expect(u.reason).not.toMatch(/budget/);
    }
  });
  it('a lane-less job names every opted-in member/lane that lacks an implementer', () => {
    const { org: fresh } = initOrg({ member: 'ada', machine: 'ada-mac',
      lanes: [{ lane: 'claude', share: 100 }, { lane: 'codex', share: 50 }] }, join(tmp(), 'org.toml'));
    const p = planOrg(fresh, [joined('ada', [['claude', 100], ['codex', 50]])], null, [{ id: 'any' }], now);
    expect(p.unassigned[0]!.reason).toBe('no implementer agent declared on ada/claude, ada/codex');
  });
  it('still reports spent budget when a staffed lane exists but cannot afford the job', () => {
    // mason-wyatt has implementer agents on claude; a 1% share leaves 0.25
    // budget points against a 2-point job — the honest 'budget' reason stays.
    const p = planOrg(org, [joined('mason-wyatt', [['claude', 1]])], null, jobs(1, { costPct: 2 }), now);
    expect(p.unassigned[0]!.reason).toBe('no contributed budget left');
  });
  it('a pinned lane nobody opted into still names the missing contribution', () => {
    const p = planOrg(org, [joined('mason-wyatt', [['claude', 100]])], null,
      [{ id: 'pinned', lane: 'codex-personal' }], now);
    expect(p.unassigned[0]!.reason).toBe('no opted-in contribution on codex-personal');
  });
});

describe('cmdOrg', () => {
  it('skips team planning without an org file and leaves the plan fields unknown', async () => {
    const home = tmp();
    vi.stubEnv('ASHLR_HOME', home);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const orgToml = join(home, 'org.toml');
      expect(await cmdOrg(['plan', '--queue', join(home, 'unread-queue.json'), '--json'])).toBe(0);
      expect(JSON.parse(log.mock.lastCall![0])).toEqual({
        schema: 'org.plan.v1', state: 'not-configured', generatedAt: null, leader: null,
        budgets: null, roles: null, assignments: null, unassigned: null, held: null, joinsDir: null,
        file: orgToml,
      });
      expect(await cmdOrg(['plan'])).toBe(0);
      expect(log).toHaveBeenLastCalledWith(`Team org not configured; planning skipped. No org file at ${orgToml}. org.toml holds org ids and lane shares only, never credentials: get a copy from your org leader, or start a new org with phm org init --member <id> --machine <id>.`);
      // --file names the probed path, not the default: the skip reports the
      // override the caller actually passed.
      const override = join(home, 'elsewhere', 'org.toml');
      expect(await cmdOrg(['plan', '--file', override, '--json'])).toBe(0);
      expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({ state: 'not-configured', file: override });
      expect(await cmdOrg(['plan', '--queue', '--json'])).toBe(1);
      expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({ schema: 'org.error.v1', error: { code: 'rejected' } });
    } finally { vi.unstubAllEnvs(); }
  });

  it('rejects an invalid or unreadable org file rather than skipping the plan', async () => {
    const dir = tmp(), invalid = join(dir, 'org.toml');
    writeFileSync(invalid, 'version = [');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const [file, message] of [[invalid, expect.stringContaining('org.toml is not valid TOML at line 1.')],
      [dir, 'Could not read org.toml.']] as const) {
      expect(await cmdOrg(['plan', '--file', file, '--json'])).toBe(1);
      expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({ schema: 'org.error.v1', error: { code: 'rejected', message } });
    }
  });

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

  it('show names the machines behind each opt-in and says the records are this machine\'s', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    const file = 'docs/examples/org.toml';
    // Only mason-scofield's record exists here, so every other lane must read
    // "not opted in" — and the footer must say that is this machine's view.
    expect(await cmdOrg(['join', '--file', file, '--member', 'mason-scofield', '--machine', 'sco-mac', '--lane', 'codex-personal=20'])).toBe(0);
    logs.pop();
    expect(await cmdOrg(['show', '--file', file])).toBe(0);
    const text = logs.pop()!;
    expect(text).toContain('lane codex-personal: 30% declared, opted in on sco-mac');
    expect(text).toContain('lane claude: 100% declared, not opted in');
    expect(text).toContain(`Opt-in counts join records held on this machine (${join(home, 'org', 'joins')})`);
    expect(await cmdOrg(['show', '--file', file, '--json'])).toBe(0);
    const shown = JSON.parse(logs.pop()!);
    expect(shown.schema).toBe('org.show.v1');
    expect(shown.joinsDir).toBe(join(home, 'org', 'joins'));
    expect(shown.joins).toHaveLength(1);
    // Plan carries the same scope note in text and the directory in JSON.
    expect(await cmdOrg(['plan', '--file', file])).toBe(0);
    expect(logs.pop()!).toContain('the plan covers only those records');
    expect(await cmdOrg(['plan', '--file', file, '--json'])).toBe(0);
    const planned = JSON.parse(logs.pop()!);
    expect(planned.schema).toBe('org.plan.v1');
    expect(planned.joinsDir).toBe(join(home, 'org', 'joins'));
    vi.unstubAllEnvs();
  });

  it('plan names the empty queue behind zero assignments in text mode', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    const file = 'docs/examples/org.toml';
    // No --queue: the plan assigns nothing, and the text must say why instead of
    // letting "0 assigned, 0 unassigned" read as a broken org.
    expect(await cmdOrg(['plan', '--file', file])).toBe(0);
    const noQueue = logs.pop()!;
    expect(noQueue).toContain('Plan for mason-wyatt:');
    expect(noQueue).toContain('Queue empty (no --queue file given)');
    expect(noQueue).toContain('--queue <jobs.json>');
    // An empty queue file gets the same note, naming the file it read.
    const empty = join(home, 'empty-queue.json'); writeFileSync(empty, '[]\n');
    expect(await cmdOrg(['plan', '--file', file, '--queue', empty])).toBe(0);
    expect(logs.pop()!).toContain(`Queue empty (${empty} held no jobs)`);
    // A queue with jobs drops the note — the per-job unassigned reasons carry
    // the explanation instead (nothing is opted in on this machine).
    const jobs = join(home, 'jobs.json');
    writeFileSync(jobs, '[{"id":"RQ-1","priority":3,"costPct":2,"lane":"claude"}]\n');
    expect(await cmdOrg(['plan', '--file', file, '--queue', jobs])).toBe(0);
    const planned = logs.pop()!;
    expect(planned).not.toContain('Queue empty');
    expect(planned).toContain('RQ-1');
    // --json stays the bare projection: no note line, no new fields.
    expect(await cmdOrg(['plan', '--file', file, '--json'])).toBe(0);
    expect(JSON.parse(logs.pop()!).schema).toBe('org.plan.v1');
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

  it('join names the declared lanes the record has not opted into', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    const file = 'docs/examples/org.toml';
    // mason-wyatt declares claude and codex-personal; a join naming only claude
    // leaves codex-personal open, and the reply must say so in both modes.
    const base = ['join', '--file', file, '--member', 'mason-wyatt', '--machine', 'mason-mac'];
    expect(await cmdOrg([...base, '--lane', 'claude=50', '--json'])).toBe(0);
    expect(JSON.parse(logs.pop()!).availableLanes).toEqual([{ lane: 'codex-personal', share: 100 }]);
    expect(await cmdOrg([...base, '--lane', 'claude=50'])).toBe(0);
    const partial = logs.pop()!;
    expect(partial).toContain('Not opted in on this machine: codex-personal (declared 100%)');
    // The hinted re-join keeps the recorded claude share and adds the open lane
    // at its declared share — a bare "--lane codex-personal" alone would drop claude.
    expect(partial).toContain('phm org join --member mason-wyatt --machine mason-mac --lane claude=50 --lane codex-personal');
    // Opting into every declared lane leaves nothing open.
    expect(await cmdOrg([...base, '--lane', 'claude', '--lane', 'codex-personal=40', '--json'])).toBe(0);
    expect(JSON.parse(logs.pop()!).availableLanes).toEqual([]);
    // The zero-lane first run contributes nothing; the note names every lane it
    // could still opt into instead of ending at "no lanes".
    expect(await cmdOrg(['join', '--file', file, '--member', 'evan-deloria', '--machine', 'evan-mac'])).toBe(0);
    const empty = logs.pop()!;
    expect(empty).toContain('no lanes (nothing contributed)');
    expect(empty).toContain('Not opted in on this machine: claude (declared 30%)');
    expect(empty).toContain('phm org join --member evan-deloria --machine evan-mac --lane claude');
    vi.unstubAllEnvs();
  });

  it('join without --machine hands back the runnable fix or names the declared machines', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    const file = 'docs/examples/org.toml';
    // Every member in the example declares exactly one machine, and `phm org
    // show` does not list machine ids — so the refusal prints the complete
    // join command, lanes included, instead of dead-ending on a lookup.
    expect(await cmdOrg(['join', '--file', file, '--member', 'evan-deloria', '--lane', 'claude=20', '--json'])).toBe(1);
    const single = JSON.parse(logs.pop()!);
    expect(single).toMatchObject({ schema: 'org.error.v1', command: 'join', error: { code: 'rejected' } });
    expect(single.error.message).toContain('join needs --machine');
    expect(single.error.message).toContain('run: phm org join --member evan-deloria --machine evan-mac --lane claude=20');
    // The fix is a command to run, not a silent join: nothing was recorded.
    expect(readJoins()).toEqual([]);
    // A member with several declared machines gets the choice named, not a guess.
    const multi = join(home, 'multi.toml');
    writeFileSync(multi, [
      'version = 1', 'leader = "ada"', '',
      '[[members]]', 'id = "ada"', 'name = "Ada"', 'role = "founder"',
      'machines = [{ id = "ada-mac" }, { id = "ada-laptop" }]',
      'contributions = [{ lane = "claude", share = 50 }]', '',
    ].join('\n'));
    expect(await cmdOrg(['join', '--file', multi, '--member', 'ada', '--json'])).toBe(1);
    expect(JSON.parse(logs.pop()!).error.message)
      .toContain('join needs --machine. ada declares machines: ada-mac, ada-laptop — pass --machine <id>.');
    // A member declaring no machines is told to ask the leader, not handed a command.
    const empty = join(home, 'empty.toml');
    writeFileSync(empty, [
      'version = 1', 'leader = "ada"', '',
      '[[members]]', 'id = "ada"', 'name = "Ada"', 'role = "founder"',
      'contributions = [{ lane = "claude", share = 50 }]', '',
    ].join('\n'));
    expect(await cmdOrg(['join', '--file', empty, '--member', 'ada', '--json'])).toBe(1);
    expect(JSON.parse(logs.pop()!).error.message).toContain('ada declares no machines in org.toml');
    // Unknown member and missing --member keep naming what is actually missing.
    expect(await cmdOrg(['join', '--file', file, '--member', 'ghost', '--json'])).toBe(1);
    expect(JSON.parse(logs.pop()!).error.message).toContain('Unknown member ghost');
    expect(await cmdOrg(['join', '--file', file, '--machine', 'evan-mac', '--json'])).toBe(1);
    expect(JSON.parse(logs.pop()!).error.message).toContain('join needs --member.');
    expect(await cmdOrg(['join', '--file', file, '--json'])).toBe(1);
    expect(JSON.parse(logs.pop()!).error.message).toContain('join needs --member and --machine.');
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

  it('accepts comma-separated --lane lists on init and join', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    const file = join(home, 'org.toml');
    // init: --lane a,b declares both lanes; =<share> still binds its own lane only.
    expect(await cmdOrg(['init', '--member', 'ada', '--machine', 'ada-mac', '--lane', 'claude,devin=20', '--json'])).toBe(0);
    expect(JSON.parse(logs.pop()!).lanes).toEqual([{ lane: 'claude', share: 100 }, { lane: 'devin', share: 20 }]);
    // join: the same list spelling opts this machine into both declared lanes;
    // a space after the comma trims away and a bare item keeps the declared share.
    expect(await cmdOrg(['join', '--file', file, '--member', 'ada', '--machine', 'ada-mac',
      '--lane', 'claude=10, devin', '--json'])).toBe(0);
    expect(JSON.parse(logs.pop()!).record.lanes).toEqual([{ lane: 'claude', share: 10 }, { lane: 'devin', share: 20 }]);
    // A lane repeated across the comma is still refused, a bad share names its
    // item, and a stray comma lands on the empty-name error — never dropped.
    for (const [lane, said] of [
      ['claude,claude', 'more than once'],
      ['claude,devin=abc', 'share must be a number'],
      ['claude,', 'needs a lane name'],
    ] as const) {
      expect(await cmdOrg(['join', '--file', file, '--member', 'ada', '--machine', 'ada-mac', '--lane', lane, '--json']), lane).toBe(1);
      expect(JSON.parse(logs.pop()!).error.message).toContain(said);
    }
    vi.unstubAllEnvs();
  });

  it('init --agent declares implementers so a fresh org can actually plan work', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    const file = join(home, 'org.toml');
    // The first-run path in one pass: init with an agent, opt the machine in,
    // then plan — before --agent existed this dead-ended on "no implementer".
    expect(await cmdOrg(['init', '--member', 'ada', '--machine', 'ada-mac', '--lane', 'claude',
      '--agent', 'ada-claude:claude', '--json'])).toBe(0);
    const init = JSON.parse(logs.pop()!);
    expect(init.agents).toEqual([{ id: 'ada-claude', lane: 'claude', machine: 'ada-mac',
      roles: ['implementer'], reports_to: 'ada' }]);
    expect(await cmdOrg(['join', '--file', file, '--member', 'ada', '--machine', 'ada-mac', '--lane', 'claude', '--json'])).toBe(0);
    logs.pop();
    const queue = join(home, 'jobs.json');
    writeFileSync(queue, JSON.stringify([{ id: 'RQ-1', priority: 3, costPct: 2, lane: 'claude' }]));
    expect(await cmdOrg(['plan', '--file', file, '--queue', queue, '--json'])).toBe(0);
    const plan = JSON.parse(logs.pop()!);
    expect(plan.assignments).toEqual([{ job: 'RQ-1', member: 'ada', agent: 'ada-claude', lane: 'claude', costPct: 2 }]);
    expect(plan.unassigned).toEqual([]);
    // Text mode names the agents the file declares.
    const other = join(home, 'other.toml');
    expect(await cmdOrg(['init', '--file', other, '--member', 'grace', '--machine', 'g-mac',
      '--lane', 'devin=50', '--lane', 'codex', '--agent', 'grace-devin:devin', '--agent', 'grace-codex:codex'])).toBe(0);
    const text = logs.pop()!;
    expect(text).toContain('agents grace-devin (implementer on devin), grace-codex (implementer on codex)');
    vi.unstubAllEnvs();
  });

  it('refuses malformed --agent arguments with the org envelope', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    const file = join(home, 'org.toml');
    const base = ['init', '--member', 'ada', '--machine', 'ada-mac', '--lane', 'claude'];
    const malformed: [string[], string][] = [
      [[...base, '--agent', 'ada-claude', '--json'], '--agent takes <id>:<lane>'],   // no lane
      [[...base, '--agent', ':claude', '--json'], '--agent takes <id>:<lane>'],    // empty id
      [[...base, '--agent', 'ada-claude:', '--json'], '--agent takes <id>:<lane>'],// empty lane
      [[...base, '--agent', 'a:b:c', '--json'], '--agent takes <id>:<lane>'],      // extra colon
      [[...base, '--agent', 'x:devin', '--json'], 'not a contribution'],           // lane never declared
      [[...base, '--agent', 'ada:claude', '--json'], 'Duplicate id'],              // agent id is the member id
      [[...base, '--agent', 'a1:claude', '--agent', 'a1:claude', '--json'], 'more than once'],
      [[...base, '--agent', '--json'], '--agent needs a value'],
    ];
    for (const [args, said] of malformed) {
      expect(await cmdOrg(args), args.join(' ')).toBe(1);
      const failure = JSON.parse(logs.pop()!);
      expect(failure).toMatchObject({ schema: 'org.error.v1', command: 'init', error: { code: 'rejected' } });
      expect(failure.error.message).toContain(said);
    }
    // A repeated agent id on different lanes is still one agent id — refused.
    expect(await cmdOrg([...base, '--agent', 'a1:claude', '--agent', 'a1:devin', '--json'])).toBe(1);
    expect(JSON.parse(logs.pop()!).error.message).toContain('more than once');
    // Nothing was written by any refused init.
    expect(existsSync(file)).toBe(false);
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

  it('plans without evidence or market files and distinguishes missing org configuration', async () => {
    const home = tmp(), runs = tmp();
    vi.stubEnv('ASHLR_HOME', home);
    vi.stubEnv('ASHLR_RUNS_DIR', runs);
    try {
      mkdirSync(join(runs, 'queue'));
      writeFileSync(join(runs, 'queue', 'status.json'), JSON.stringify({
        schema: 'dispatchd.status.v1', last_tick: '2026-11-26T02:26:30-0500', paused: false,
        lanes: { 'codex-personal': { running: 1, target: 20, queued: 59, held: false } },
      }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await cmdOrg(['plan', '--json'])).toBe(0);
      expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({ schema: 'org.plan.v1', state: 'not-configured', assignments: null });
      expect(await cmdOrg(['plan', '--file', 'docs/examples/org.toml', '--json'])).toBe(0);
      expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({ schema: 'org.plan.v1', assignments: [] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('plan text names each held lane and the join that opts it in', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    const file = 'docs/examples/org.toml';
    // mason-wyatt opts claude in at zero share and codex-personal at 50; scofield
    // opts codex-personal in. evan-deloria never joins: both held reasons show.
    expect(await cmdOrg(['join', '--file', file, '--member', 'mason-wyatt', '--machine', 'mason-mac',
      '--lane', 'claude=0', '--lane', 'codex-personal=50', '--json'])).toBe(0);
    expect(await cmdOrg(['join', '--file', file, '--member', 'mason-scofield', '--machine', 'sco-mac',
      '--lane', 'codex-personal', '--json'])).toBe(0);
    logs.length = 0;
    expect(await cmdOrg(['plan', '--file', file])).toBe(0);
    const text = logs.pop()!;
    expect(text).toContain('2 lanes held');
    expect(text).toContain('held mason-wyatt/claude: zero share');
    // The fix keeps the record's other opt-in (codex-personal=50) — a bare
    // --lane claude re-join would replace the whole record and drop it.
    expect(text).toContain('phm org join --member mason-wyatt --machine mason-mac --lane codex-personal=50 --lane claude');
    expect(text).toContain('held evan-deloria/claude: not opted in');
    expect(text).toContain('phm org join --member evan-deloria --machine evan-mac --lane claude');
    expect(text).not.toContain('held mason-scofield/');
    // --json output is unchanged: the same held rows were already in the plan.
    expect(await cmdOrg(['plan', '--file', file, '--json'])).toBe(0);
    const plan = JSON.parse(logs.pop()!);
    expect(plan.held.map((h: any) => `${h.member}/${h.lane}`)).toEqual(['mason-wyatt/claude', 'evan-deloria/claude']);
    vi.unstubAllEnvs();
  });

  it('plan held fix keeps every opt-in the machine record already carries', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    // The printed fix names no --file: it is written for the member's machine,
    // where org.toml sits at the default path. Stage the example there.
    const file = join(home, 'org.toml');
    writeFileSync(file, readFileSync('docs/examples/org.toml', 'utf8'));
    // mason-wyatt opts claude in at zero share and codex-personal at 50, so claude
    // is held. The printed fix must re-join with both lanes or codex-personal drops.
    expect(await cmdOrg(['join', '--member', 'mason-wyatt', '--machine', 'mason-mac',
      '--lane', 'claude=0', '--lane', 'codex-personal=50', '--json'])).toBe(0);
    logs.length = 0;
    expect(await cmdOrg(['plan'])).toBe(0);
    const fixLine = logs.pop()!.split('\n').find((l) => l.includes('held mason-wyatt/claude'))!;
    const command = fixLine.slice(fixLine.indexOf('phm org join'));
    expect(command).toBe('phm org join --member mason-wyatt --machine mason-mac --lane codex-personal=50 --lane claude');
    // Run the printed fix verbatim: nothing the record carried may be dropped.
    const argv = command.replace(/^phm org /, '').split(' ');
    expect(await cmdOrg([...argv, '--json'])).toBe(0);
    const reply = JSON.parse(logs.pop()!);
    expect(reply.droppedLanes).toEqual([]);
    expect(reply.record.lanes).toEqual([{ lane: 'codex-personal', share: 50 }, { lane: 'claude', share: 100 }]);
    vi.unstubAllEnvs();
  });

  it('plan held fix names the recorded machine when a member has several', async () => {
    const home = tmp(); vi.stubEnv('ASHLR_HOME', home); vi.stubEnv('HOME', home);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => { logs.push(String(s)); });
    const file = join(home, 'org.toml');
    writeFileSync(file, 'version = 1\nleader = "ada"\n\n'
      + '[[members]]\nid = "ada"\nname = "Ada"\nrole = "founder"\n'
      + 'machines = [{ id = "ada-mac-a" }, { id = "ada-mac-b" }]\n'
      + 'contributions = [{ lane = "claude", share = 50 }, { lane = "devin", share = 20 }]\n');
    // Only ada-mac-a has a record (claude opted in); devin is held. The fix names
    // ada-mac-a concretely and keeps claude=50 instead of the <a|b> placeholder.
    expect(await cmdOrg(['join', '--file', file, '--member', 'ada', '--machine', 'ada-mac-a',
      '--lane', 'claude', '--json'])).toBe(0);
    logs.length = 0;
    expect(await cmdOrg(['plan', '--file', file])).toBe(0);
    const text = logs.pop()!;
    expect(text).toContain('held ada/devin: not opted in');
    expect(text).toContain('phm org join --member ada --machine ada-mac-a --lane claude=50 --lane devin');
    vi.unstubAllEnvs();
  });
});
