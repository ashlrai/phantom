import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'smol-toml';
import { joinOrg, loadOrg, parseQueue, planOrg, readJoins, validateOrg, type JoinRecord } from '../src/core/org/org.js';
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
});
