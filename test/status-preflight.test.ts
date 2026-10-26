/**
 * `phm status` preflight section (design-custody-fleet.md 3.5 and decision 2):
 * quiet unless ASHLR_PHANTOM_PREFLIGHT=1, metadata-only unless
 * ASHLR_PHANTOM_PREFLIGHT_VAULT=1, value-free, and it reports what a fleet
 * spawn would do (wrap, or unwrapped with the custody reason).
 */
import { describe, expect, it } from 'vitest';
import { formatPreflightStatusLine, gatherPreflightStatus } from '../src/cli/status-preflight.js';
import { runPhantomPreflight, type PreflightRunner } from '../src/core/run/phantom-preflight.js';

const doc = (verdict: string, vault = false, ids: string[] = []) =>
  JSON.stringify({ schema_version: 1, kind: 'phantom.agent.preflight', verdict, vault_probed: vault, checks: ids.map((id) => ({ id, severity: 'warning', requires_approval: false })) });

function recorder(status: number | null, stdout: string) {
  const calls: string[][] = [];
  const runner: PreflightRunner = (_bin, args) => { calls.push([...args]); return { status, stdout }; };
  return { calls, runner };
}
const on = { ASHLR_PHANTOM_PREFLIGHT: '1' };
const ok = () => ({ installed: true, initialized: true });

describe('status preflight', () => {
  it('is null and never spawns when the gate is off', () => {
    const r = recorder(0, doc('ready'));
    expect(gatherPreflightStatus({ env: {}, runner: r.runner, phantom: ok })).toBeNull();
    expect(gatherPreflightStatus({ env: { ASHLR_PHANTOM_PREFLIGHT: 'true' }, runner: r.runner, phantom: ok })).toBeNull();
    expect(r.calls).toEqual([]);
  });

  it('is null when phantom is missing or the project is not configured', () => {
    const r = recorder(0, doc('ready'));
    expect(gatherPreflightStatus({ env: on, runner: r.runner, phantom: () => ({ installed: false, initialized: false }) })).toBeNull();
    expect(gatherPreflightStatus({ env: on, runner: r.runner, phantom: () => ({ installed: true, initialized: false }) })).toBeNull();
    expect(r.calls).toEqual([]);
  });

  it('ready: metadata only (no --vault), spawns wrap', () => {
    const r = recorder(0, doc('ready'));
    const s = gatherPreflightStatus({ env: on, runner: r.runner, phantom: ok })!;
    expect(r.calls).toEqual([['agent', 'doctor', '--json', '--strict']]);
    expect(s).toEqual({ verdict: 'ready', exit: 0, vaultProbed: false, spawn: 'wrap', reason: null, checkIds: [] });
    expect(formatPreflightStatusLine(s)).toBe('ready (exit 0, metadata only) · spawns wrap');
  });

  it('ASHLR_PHANTOM_PREFLIGHT_VAULT=1 adds --vault and requires vault_probed true', () => {
    const r = recorder(0, doc('ready', true));
    const s = gatherPreflightStatus({ env: { ...on, ASHLR_PHANTOM_PREFLIGHT_VAULT: '1' }, runner: r.runner, phantom: ok })!;
    expect(r.calls).toEqual([['agent', 'doctor', '--json', '--strict', '--vault']]);
    expect(s.vaultProbed).toBe(true);
    expect(s.spawn).toBe('wrap');
    expect(formatPreflightStatusLine(s)).toContain('with vault probe');
  });

  it('a vault run that reports vault_probed false is not trusted', () => {
    const r = recorder(0, doc('ready', false));
    const s = gatherPreflightStatus({ env: { ...on, ASHLR_PHANTOM_PREFLIGHT_VAULT: '1' }, runner: r.runner, phantom: ok })!;
    expect(s).toMatchObject({ verdict: 'unavailable', spawn: 'unwrapped', reason: 'preflight-unavailable' });
  });

  it('blocked and degraded refuse wrapping with preflight-blocked and show ids only', () => {
    for (const [code, verdict] of [[1, 'blocked'], [2, 'degraded']] as const) {
      const r = recorder(code, doc(verdict, false, ['invalid-config', 'sk-live-abcdef0123456789']));
      const s = gatherPreflightStatus({ env: on, runner: r.runner, phantom: ok })!;
      expect(s).toEqual({ verdict, exit: code, vaultProbed: false, spawn: 'unwrapped', reason: 'preflight-blocked', checkIds: ['invalid-config'] });
      const line = formatPreflightStatusLine(s);
      expect(line).toBe(`${verdict} (exit ${code}, metadata only) [invalid-config] · spawns run unwrapped (preflight-blocked)`);
      expect(line).not.toContain('sk-live');
    }
  });

  it('old phantom or garbage output: unavailable, unwrapped', () => {
    const r = recorder(2, 'error: unknown flag --json');
    const s = gatherPreflightStatus({ env: on, runner: r.runner, phantom: ok })!;
    expect(s).toEqual({ verdict: 'unavailable', exit: 2, vaultProbed: false, spawn: 'unwrapped', reason: 'preflight-unavailable', checkIds: [] });
  });
});

describe('spawn preflight vault opt-in', () => {
  it('runPhantomPreflight reads ASHLR_PHANTOM_PREFLIGHT_VAULT when no explicit vault is given; explicit false wins', () => {
    const prev = process.env['ASHLR_PHANTOM_PREFLIGHT_VAULT'];
    try {
      delete process.env['ASHLR_PHANTOM_PREFLIGHT_VAULT'];
      let r = recorder(0, doc('ready'));
      expect(runPhantomPreflight('.', r.runner).verdict).toBe('ready');
      expect(r.calls[0]).not.toContain('--vault');
      process.env['ASHLR_PHANTOM_PREFLIGHT_VAULT'] = '1';
      r = recorder(0, doc('ready', true));
      expect(runPhantomPreflight('.', r.runner).verdict).toBe('ready');
      expect(r.calls[0]).toContain('--vault');
      r = recorder(0, doc('ready'));
      expect(runPhantomPreflight('.', r.runner, { vault: false }).verdict).toBe('ready');
      expect(r.calls[0]).not.toContain('--vault');
    } finally {
      if (prev === undefined) delete process.env['ASHLR_PHANTOM_PREFLIGHT_VAULT']; else process.env['ASHLR_PHANTOM_PREFLIGHT_VAULT'] = prev;
    }
  });
});
