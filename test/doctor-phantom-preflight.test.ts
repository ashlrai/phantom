import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkPhantomPreflight } from '../src/core/doctor.js';
import { runPhantomPreflight, type PreflightRunner } from '../src/core/run/phantom-preflight.js';

const ready = { installed: true, initialized: true };
function doc(verdict: string, vaultProbed: boolean, checks: unknown[] = []): string {
  return JSON.stringify({ schema_version: 1, kind: 'phantom.agent.preflight', verdict, vault_probed: vaultProbed, checks });
}
function runner(status: number, stdout: string, seen: string[][] = []): PreflightRunner {
  return (_bin, args) => { seen.push([...args]); return { status, stdout }; };
}

describe('doctor: phantom strict preflight', () => {
  it('skips when phantom is not set up', () => {
    expect(checkPhantomPreflight({ status: { installed: false, initialized: false }, runner: runner(0, doc('ready', false)) }).status).toBe('pass');
  });

  it('ready passes metadata-only and never passes --vault by default', () => {
    const seen: string[][] = [];
    const c = checkPhantomPreflight({ status: ready, env: {}, runner: runner(0, doc('ready', false), seen) });
    expect(c.status).toBe('pass');
    expect(c.detail).toContain('metadata only');
    expect(seen[0]).not.toContain('--vault');
  });

  it('blocked and degraded warn with value-free check ids only', () => {
    const fake = `sk-live-${randomBytes(8).toString('hex')}`;
    const c = checkPhantomPreflight({ status: ready, env: {}, runner: runner(1, doc('blocked', false, [{ id: 'audit-disabled' }, { id: fake }])) });
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('blocked');
    expect(c.detail).toContain('audit-disabled');
    expect(c.detail).not.toContain(fake);
  });

  it('ASHLR_DOCTOR_PHANTOM_VAULT=1 adds --vault and requires vault_probed true', () => {
    const seen: string[][] = [];
    const c = checkPhantomPreflight({ status: ready, env: { ASHLR_DOCTOR_PHANTOM_VAULT: '1' }, runner: runner(0, doc('ready', true), seen) });
    expect(seen[0]).toContain('--vault');
    expect(c.status).toBe('pass');
    expect(c.detail).toContain('with vault probe');
    // A vault run that claims it did not probe, or a default run that claims it did, is not trusted.
    expect(checkPhantomPreflight({ status: ready, env: { ASHLR_DOCTOR_PHANTOM_VAULT: '1' }, runner: runner(0, doc('ready', false)) }).status).toBe('warn');
    expect(runPhantomPreflight('/tmp', runner(0, doc('ready', true))).verdict).toBe('unavailable');
  });

  it('a throwing runner warns and never throws', () => {
    expect(checkPhantomPreflight({ status: ready, env: {}, runner: () => { throw new Error('boom'); } }).status).toBe('warn');
  });
});
