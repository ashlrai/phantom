import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Fixture integrity only: parser integration requires a separate authorized
// change to the Tier-1 Locus consumer and its CODEOWNERS-covered tests.
const root = new URL('./fixtures/locus-contract/0.5.1/', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const json = (path: string): Record<string, unknown> => JSON.parse(read(path));
const scenarios = ['fresh-home', 'pinned-capability-not-exported', 'pinned-capability-exported', 'short-pin'];

describe('real Locus 0.5.1 fixture corpus', () => {
  it('records producer version and source provenance', () => {
    expect(read('version.txt').trim()).toBe('locus 0.5.1');
    expect(json('manifest.json')).toMatchObject({
      producer: 'locus', version: '0.5.1',
      sourceCommit: 'cba5f65061003f60e34f27eeea6784d3294f9be7',
      binarySourceProvenance: 'caller-supplied-not-attested',
    });
  });

  for (const scenario of scenarios) {
    it(`${scenario}: handshake is capability discovery, not a readiness report`, () => {
      const handshake = json(`${scenario}/handshake.json`);
      expect(handshake).toMatchObject({
        kind: 'ashlr.handshake', schema_version: 1, name: 'locus', version: '0.5.1',
        protocols: { 'ashlr.handshake': 1, 'phantom.agent.preflight': 1 },
      });
      expect(handshake.capabilities).toEqual(expect.arrayContaining(['doctor-fix', 'doctor-json']));
      expect(handshake).not.toHaveProperty('ready');
      expect(handshake).not.toHaveProperty('session_ok');
    });

    it(`${scenario}: retains distinct report, session and watch envelopes`, () => {
      const report = json(`${scenario}/agent-report.json`);
      expect(report.version).toBe('0.5.1');
      expect(typeof report.ready).toBe('boolean');
      expect(report.required_servers).toEqual(['locus', 'phantom']);
      expect(json(`${scenario}/verify-session.json`).kind).toBe('session');
      expect(json(`${scenario}/watch-once.json`).kind).toBe('watch');
      expect(read(`${scenario}/status-oneline.txt`).trim()).not.toContain('\n');
    });
  }
});

it('keeps dry-run doctor repairs separate from execution authority', () => {
  for (const scenario of scenarios) {
    expect(json(`${scenario}/doctor-fix.json`)).toMatchObject({
      mode: 'dry_run', outcome: null,
      plan: { fixes: [], report_only: [] },
    });
  }
  expect(json('pinned-capability-not-exported/watch-once.json')).toMatchObject({
    session_ok: false, safe_next: 'doctor_fix', pinned: true, frozen: false,
  });
});

it('captures expiry metadata and the human renewal hint separately from oneline status', () => {
  expect(json('short-pin/status.json')).toMatchObject({
    pinned: true, expired: false, expires_at: '<EXPIRES_AT>', expires_in_secs: 1,
  });
  expect(read('short-pin/status-human.txt')).toContain('expires  <COUNTDOWN>  (renew: locus enter acme)');
  expect(read('short-pin/status-oneline.txt').trim()).toBe('acme:acme-corp');
  expect(read('pinned-capability-exported/status-human.txt')).toContain('expires  <COUNTDOWN>');
  expect(read('pinned-capability-exported/status-human.txt')).not.toContain('(renew:');
});
