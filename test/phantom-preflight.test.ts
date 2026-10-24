import { describe, expect, it } from 'vitest';
import {
  PHANTOM_PREFLIGHT_ARGS,
  interpretPhantomPreflight,
  runPhantomPreflight,
} from '../src/core/run/phantom-preflight.js';

function doc(verdict: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    kind: 'phantom.agent.preflight',
    verdict,
    readiness: 'protected',
    risk_level: 'low',
    vault_probed: false,
    checks: [{ id: 'env-parse-error', severity: 'warning', requires_approval: false }],
    wrap: { exec_ready: verdict === 'ready', blocked_by: [] },
    ...extra,
  });
}

describe('phantom strict preflight', () => {
  it('calls agent doctor --json --strict and never --vault', () => {
    let seen: readonly string[] = [];
    runPhantomPreflight('/x', (_b, args) => {
      seen = args;
      return { status: 0, stdout: doc('ready') };
    });
    expect(seen).toEqual(['agent', 'doctor', '--json', '--strict']);
    expect(PHANTOM_PREFLIGHT_ARGS).not.toContain('--vault');
  });

  it('exit 0 with a ready document may wrap', () => {
    const r = interpretPhantomPreflight({ status: 0, stdout: doc('ready') });
    expect(r).toMatchObject({ verdict: 'ready', exit: 0, mayWrap: true });
    expect(r.checkIds).toEqual(['env-parse-error']);
  });

  it.each([
    [1, 'blocked'],
    [2, 'degraded'],
  ] as const)('exit %i is %s and never wraps', (status, verdict) => {
    expect(interpretPhantomPreflight({ status, stdout: doc(verdict) })).toMatchObject({
      verdict,
      exit: status,
      mayWrap: false,
      reason: 'preflight-blocked',
    });
  });

  it.each([
    ['exit 3 could not evaluate', { status: 3, stdout: doc('blocked') }],
    ['unknown exit code', { status: 7, stdout: doc('ready') }],
    ['signal or timeout', { status: null, stdout: '' }],
    ['spawn error', { status: null, stdout: '', error: new Error('ENOENT') }],
    ['unparsable stdout', { status: 0, stdout: 'not json' }],
    ['wrong schema', { status: 0, stdout: doc('ready', { schema_version: 2 }) }],
    ['wrong kind', { status: 0, stdout: doc('ready', { kind: 'phantom.agent.report' }) }],
    ['verdict disagrees with exit', { status: 0, stdout: doc('blocked') }],
    ['vault was probed', { status: 0, stdout: doc('ready', { vault_probed: true }) }],
    ['oversized output', { status: 0, stdout: 'x'.repeat(300 * 1024) }],
  ])('%s is unavailable and never wraps', (_name, run) => {
    const r = interpretPhantomPreflight(run);
    expect(r.verdict).toBe('unavailable');
    expect(r.mayWrap).toBe(false);
    expect(r.reason).toBe('preflight-unavailable');
  });

  it('drops check ids that are not short kebab-case', () => {
    const fakeKey = `sk-fake-${Date.now().toString(36)}`;
    const r = interpretPhantomPreflight({
      status: 0,
      stdout: doc('ready', { checks: [{ id: fakeKey + ' /home/u' }, { id: 'invalid-config' }, { id: 5 }] }),
    });
    expect(r.checkIds).toEqual(['invalid-config']);
  });

  it('a throwing runner is unavailable', () => {
    expect(
      runPhantomPreflight('/x', () => {
        throw new Error('boom');
      }).verdict,
    ).toBe('unavailable');
  });
});
