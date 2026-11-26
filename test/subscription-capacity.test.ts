import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeSeats } from '../src/cli/route.js';
import { enumerateRouteCandidates, loadRouteSources, rankRouteCandidates } from '../src/core/routing/decision-candidates.js';
import { routeRequestSchema } from '../src/core/routing/decision-schema.js';
import { decideRoute } from '../src/core/routing/decision.js';
import { googleSeatReadout, parseDeclaredSeats, seatCapacity, seatLabel, SUBSCRIPTION_CAPACITY } from '../src/core/routing/subscription-capacity.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

const google = (product: string, kind: string, plan: string) =>
  SUBSCRIPTION_CAPACITY.find(r => r.product === product && r.account_kind === kind && r.plan === plan);

describe('subscription capacity table', () => {
  it('encodes Google plans with account kind, models, refresh and caps; unknown caps stay null', () => {
    expect(google('antigravity', 'personal', 'free')).toMatchObject({ cost_class: 'free', refresh: ['weekly'], neon: false,
      daily_requests: null, weekly_cap: null });
    expect(google('antigravity', 'personal', 'free')!.models).not.toContain('gemini-4-neon');
    expect(google('antigravity', 'personal', 'google-ai-pro')).toMatchObject({ refresh: ['5h', 'weekly'], neon: true, opt_in: false });
    expect(google('antigravity', 'personal', 'google-ai-pro')!.models).toEqual(expect.arrayContaining(['gemini-4-neon', 'gemini-4-carbon', 'claude-opus-5-5']));
    expect(google('antigravity', 'workspace', 'workspace')).toMatchObject({ label: 'starter-quota', models: null, neon: false });
    expect(Object.fromEntries(SUBSCRIPTION_CAPACITY.filter(r => r.product === 'gemini-cli').map(r => [`${r.account_kind}:${r.plan}`, r.daily_requests])))
      .toEqual({ 'personal:code-assist-individuals': 1000, 'personal:google-ai-pro': 1500, 'personal:google-ai-ultra': 2000,
        'workspace:code-assist-standard': 1500, 'workspace:code-assist-enterprise': 2000, 'api-key:unpaid': 250 });
    expect(SUBSCRIPTION_CAPACITY.filter(r => r.product === 'gemini-cli').every(r => r.neon === false && r.weekly_cap === null)).toBe(true);
  });

  it('keeps metered rows opt-in and off the Gemini API free tier Neon', () => {
    expect(SUBSCRIPTION_CAPACITY.filter(r => r.opt_in).map(r => `${r.product}:${r.plan}`)).toEqual(['antigravity:google-cloud', 'gemini-api:paid-tier']);
    expect(google('gemini-api', 'api-key', 'free-tier')).toMatchObject({ neon: false, cost_class: 'free' });
  });
});

describe('declared Google seats', () => {
  it('parses strictly and labels Workspace Antigravity starter-quota', () => {
    expect(parseDeclaredSeats({ agy: { account_kind: 'workspace' }, gemini: { account_kind: 'corp', plan: 'x' }, codex: { account_kind: 'personal', plan: 'pro', token: 'x' } }))
      .toEqual({ agy: { account_kind: 'workspace', plan: 'workspace' } });
    expect(seatLabel('agy', { account_kind: 'workspace', plan: 'workspace' })).toBe('starter-quota');
    expect(seatLabel('agy', { account_kind: 'workspace', plan: 'unlisted' })).toBe('starter-quota');
    expect(seatLabel('agy', { account_kind: 'workspace', plan: 'gemini-enterprise' })).toBeNull();
    expect(seatLabel('agy', { account_kind: 'personal', plan: 'google-ai-pro' })).toBeNull();
    expect(seatLabel('gemini', { account_kind: 'workspace', plan: 'code-assist-standard' })).toBeNull();
    expect(seatCapacity('agy', { account_kind: 'personal', plan: 'unlisted' })).toBeNull();
  });

  it('reports the active Google seat and whether it reaches Neon', () => {
    expect(googleSeatReadout({ agy: { account_kind: 'personal', plan: 'google-ai-ultra' } })).toMatchObject({ active: 'agy', neon: true, metered_opt_in: false });
    const workspace = googleSeatReadout({ agy: { account_kind: 'workspace', plan: 'workspace' }, gemini: { account_kind: 'personal', plan: 'google-ai-pro' } });
    expect(workspace).toMatchObject({ schema: 'route.subscription-capacity.v1', active: 'gemini', neon: false });
    expect(workspace.seats.find(s => s.lane === 'agy')).toMatchObject({ active: false, label: 'starter-quota' });
    expect(workspace.seats.find(s => s.lane === 'gemini')).toMatchObject({ active: true, daily_requests: 1500, refresh: ['daily'] });
    expect(googleSeatReadout({ agy: { account_kind: 'workspace' } })).toMatchObject({ active: 'agy', neon: false });
    expect(googleSeatReadout({ agy: { account_kind: 'cloud-project', plan: 'google-cloud' } })).toMatchObject({ active: null, neon: null });
    expect(googleSeatReadout(null)).toMatchObject({ active: null, neon: null });
  });
});

describe('router seat preference', () => {
  const request = routeRequestSchema.parse({ task_class: 'bug-fix', repo: 'phantom', tier_hint: 'work',
    lane_candidates: ['agy', 'codex'], quota_state: { agy: 'available', codex: 'available' },
    machine_state: { admit: true, running_by_lane: { agy: 0, codex: 0 } } });
  const sources = (seats: unknown) => ({ models: { agy: 'gemini-4-neon-high', codex: 'gpt-6.1-sol' },
    slots: { agy: { target: 1, hard_cap: 1 }, codex: { target: 1, hard_cap: 1 } }, admission: { admit: true }, seats });

  it('ranks a Workspace Antigravity seat after other seats and labels the decision', async () => {
    const ranked = rankRouteCandidates(request, enumerateRouteCandidates(request, sources({ agy: { account_kind: 'workspace' } })));
    expect(ranked.map(c => [c.lane, c.seat_label ?? null])).toEqual([['codex', null], ['agy', 'starter-quota']]);
    const personal = enumerateRouteCandidates(request, sources({ agy: { account_kind: 'personal', plan: 'google-ai-pro' } }));
    expect(personal.every(c => c.seat_label === undefined)).toBe(true);
    const only = routeRequestSchema.parse({ ...request, lane_candidates: ['agy'] });
    const report = await decideRoute(only, sources({ agy: { account_kind: 'workspace' } }), { backends: [] });
    expect(report).toMatchObject({ lane: 'agy', seat_label: 'starter-quota' });
  });

  it('reads queue/subscription-seats.json and prints the readout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'phm-seats-')); dirs.push(root);
    await mkdir(join(root, 'queue'), { recursive: true });
    await writeFile(join(root, 'queue/subscription-seats.json'), JSON.stringify({ agy: { account_kind: 'personal', plan: 'google-ai-pro' } }));
    expect((await loadRouteSources(root)).seats).toEqual({ agy: { account_kind: 'personal', plan: 'google-ai-pro' } });
    const out = vi.fn();
    expect(await routeSeats(['--root', root, '--json'], out)).toBe(0);
    expect(JSON.parse(out.mock.calls[0]![0])).toMatchObject({ active: 'agy', neon: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await routeSeats(['--root', root], out)).toBe(2);
    err.mockRestore();
  });
});
