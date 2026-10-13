import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runEcosystemUp, requiredChecksFromRules, locateRepo, ECOSYSTEM_REPOS, ECOSYSTEM_RESERVED_ACTIONS, type EcosystemDeps, type GrantState } from '../src/core/ecosystem/onboard.js';
import { parseUpArgs, renderEcosystemReport } from '../src/cli/ecosystem-up.js';
import { isReadOnlyProbe } from '../src/core/ecosystem/onboard-deps.js';

const WS = '/ws';
function fake(over: { onDisk?: string[]; autoMerge?: boolean; checks?: string[]; grant?: GrantState; ghOk?: boolean } = {}) {
  const disk = new Set((over.onDisk ?? []).map((n) => join(WS, n, '.git')));
  const enrolled: string[] = [];
  const autos: { id: string; name: string; enabled: boolean }[] = [];
  let grant: GrantState = over.grant ?? { state: 'none', repos: [], grantSeq: null, eliteDirect: false };
  const calls = { clone: 0, enroll: 0, sign: 0 };
  const deps: EcosystemDeps = {
    now: () => new Date('2026-10-13T12:00:00Z'),
    exists: (p) => disk.has(p),
    run: async (_bin, args) => {
      if (args[0] === 'auth') return { code: over.ghOk === false ? 1 : 0, stdout: '', stderr: '' };
      if (String(args[1]).includes('/rules/')) return { code: 0, stdout: JSON.stringify((over.checks ?? ['test']).map((c) => ({ type: 'required_status_checks', parameters: { required_status_checks: [{ context: c }] } }))), stderr: '' };
      return { code: 0, stdout: JSON.stringify({ allow_auto_merge: over.autoMerge ?? true, default_branch: 'main' }), stderr: '' };
    },
    clone: async (_n, dest) => { calls.clone++; disk.add(join(dest, '.git')); return { code: 0, stdout: '', stderr: '' }; },
    listEnrolled: () => [...enrolled],
    enroll: (p) => { calls.enroll++; enrolled.push(p); return { ok: true, changed: true }; },
    grantState: async () => grant,
    signGrant: async () => { calls.sign++; grant = { state: 'active', repos: ECOSYSTEM_REPOS.map((r) => `ashlrai/${r.name}`), grantSeq: 7, eliteDirect: false }; return { ok: true, detail: 'Installed grant #7' }; },
    confirm: async () => true,
    automations: {
      list: async () => autos.map((a) => ({ ...a })),
      createFromTemplate: async (_t, name) => { const a = { id: `a${autos.length}`, name, enabled: false }; autos.push(a); return { id: a.id }; },
      enable: async (id) => { autos.find((a) => a.id === id)!.enabled = true; },
    },
    residentState: async () => 'running',
  };
  return { deps, calls };
}

describe('ashlr ecosystem up', () => {
  it('clones, enrolls, signs and schedules on first run, then is idempotent', async () => {
    const { deps, calls } = fake({ onDisk: ['phantom'] });
    const first = await runEcosystemUp(deps, { workspace: WS, yes: true });
    expect(calls.clone).toBe(ECOSYSTEM_REPOS.length - 1);
    expect(calls.enroll).toBe(ECOSYSTEM_REPOS.length);
    expect(calls.sign).toBe(1);
    expect(first.ready).toBe(true);
    expect(first.repos.every((r) => r.ok)).toBe(true);
    const second = await runEcosystemUp(deps, { workspace: WS, yes: true });
    expect(second.steps.every((s) => s.status === 'already')).toBe(true);
    expect(calls).toEqual({ clone: ECOSYSTEM_REPOS.length - 1, enroll: ECOSYSTEM_REPOS.length, sign: 1 });
  });

  it('dry-run and status write nothing', async () => {
    const { deps, calls } = fake();
    for (const opts of [{ dryRun: true }, { statusOnly: true }]) {
      const r = await runEcosystemUp(deps, { workspace: WS, ...opts });
      expect(r.ready).toBe(false);
      expect(r.repos.every((x) => x.present === 'would-clone')).toBe(true);
    }
    expect(calls).toEqual({ clone: 0, enroll: 0, sign: 0 });
  });

  it('never signs when the surface disallows it (MCP / web)', async () => {
    const { deps, calls } = fake({ onDisk: ECOSYSTEM_REPOS.map((r) => r.name) });
    const r = await runEcosystemUp(deps, { workspace: WS, allowGrant: false });
    expect(calls.sign).toBe(0);
    expect(r.steps.find((s) => s.step === 'grant')!.status).toBe('waiting-on-you');
    expect(r.nextCommand).toContain('ashlr ecosystem up');
  });

  it('prints exact fixes for auto-merge off, missing gates and ashlr/verify', async () => {
    const off = await runEcosystemUp(fake({ autoMerge: false, checks: [] }).deps, { statusOnly: true, workspace: WS });
    const cmds = off.repos[0]!.fixes.map((f) => f.command).join('\n');
    expect(cmds).toContain('gh repo edit ashlrai/phantom --enable-auto-merge');
    expect(cmds).toContain('ashlr authority protect');
    const verify = await runEcosystemUp(fake({ checks: ['ashlr/verify', 'test'] }).deps, { statusOnly: true, workspace: WS });
    expect(verify.repos[0]!.verifyRequired).toBe(true);
  });

  it('asks gh login first when not signed in and skips clones', async () => {
    const { deps, calls } = fake({ ghOk: false });
    const r = await runEcosystemUp(deps, { workspace: WS, yes: true });
    expect(r.steps[0]).toMatchObject({ step: 'github', status: 'waiting-on-you' });
    expect(calls.clone).toBe(0);
  });

  it('re-signs when the active grant is missing ecosystem repos', async () => {
    const { deps, calls } = fake({ onDisk: ECOSYSTEM_REPOS.map((r) => r.name), grant: { state: 'active', repos: ['ashlrai/phantom'], grantSeq: 3, eliteDirect: true } });
    await runEcosystemUp(deps, { workspace: WS, yes: true });
    expect(calls.sign).toBe(1);
  });

  it('pure helpers', () => {
    expect(requiredChecksFromRules([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'b' }, { context: 'a' }] } }, { type: 'deletion' }])).toEqual(['a', 'b']);
    expect(locateRepo('locus', WS, ['/elsewhere/locus'], (p) => p === '/elsewhere/locus/.git')).toBe('/elsewhere/locus');
    expect(ECOSYSTEM_RESERVED_ACTIONS.join(' ')).toMatch(/release tags.*secret.*delet.*spend.*outside messages/s);
    expect(isReadOnlyProbe('gh', ['api', 'repos/a/b'])).toBe(true);
    expect(isReadOnlyProbe('gh', ['api', '-X', 'POST'])).toBe(false);
    expect(isReadOnlyProbe('gh', ['repo', 'delete', 'x'])).toBe(false);
  });

  it('CLI args, JSON shape and human render', async () => {
    expect(parseUpArgs(['up', '--yes', '--json', '--repos', 'locus,lexicon'])).toMatchObject({ yes: true, json: true, repos: ['locus', 'lexicon'] });
    expect(parseUpArgs(['up', '--repos', 'nope']).error).toMatch(/unknown ecosystem repo/);
    const r = await runEcosystemUp(fake().deps, { statusOnly: true, workspace: WS });
    expect(JSON.parse(JSON.stringify(r))).toMatchObject({ schemaVersion: 1, kind: 'ashlr-ecosystem-up', mode: 'status' });
    const text = renderEcosystemReport(r, false);
    expect(text).toContain('phantom-secrets');
    expect(text).toContain('Next:');
  });
});
