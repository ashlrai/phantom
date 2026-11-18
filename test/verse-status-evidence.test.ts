import { describe, expect, it } from 'vitest';
import { formatStatusEvidence, type StatusEvidenceInput } from '../src/web-ui/routes/verse/coordination/status-evidence.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const fresh = '2026-11-18T11:59:00.000Z';
const base = (over: Partial<StatusEvidenceInput> = {}): StatusEvidenceInput => ({
  runtime: { host: 'fake-host', version: '1.2.3', pid: 4242, asOf: fresh },
  claims: { count: 3, asOf: fresh },
  owner: { name: 'fake-owner', receipt: 'bus-claim:fake:1', artifact: null, asOf: fresh },
  state: 'ASSIGNED',
  now: NOW,
  ...over,
});

describe('formatStatusEvidence', () => {
  it('prints one line per fact with as-of and source', () => {
    const out = formatStatusEvidence(base());
    expect(out).toContain('Status: ASSIGNED');
    expect(out).toContain('Runtime: host fake-host, version 1.2.3, pid 4242 · as of ' + fresh + ' · source runtime-identity');
    expect(out).toContain('Claims: 3 live · as of ' + fresh + ' · source coordination-claims');
    expect(out).toContain('Bridge owner: fake-owner · receipt bus-claim:fake:1');
  });
  it('downgrades ASSIGNED without a receipt to RECEIVED', () => {
    const out = formatStatusEvidence(base({ owner: { name: 'fake-owner', receipt: null, artifact: null, asOf: fresh } }));
    expect(out).toContain('Status: RECEIVED (requested ASSIGNED');
  });
  it('downgrades VERIFIED without an artifact', () => {
    expect(formatStatusEvidence(base({ state: 'VERIFIED' }))).toContain('Status: ASSIGNED (requested VERIFIED');
    expect(formatStatusEvidence(base({ state: 'VERIFIED', owner: null }))).toContain('Status: RECEIVED (requested VERIFIED');
    const ok = base({ state: 'VERIFIED', owner: { name: 'fake-owner', receipt: 'r', artifact: 'PR #1', asOf: fresh } });
    expect(formatStatusEvidence(ok)).toContain('Status: VERIFIED ·');
  });
  it('labels facts older than 10 minutes as stale', () => {
    const old = new Date(NOW - 11 * 60_000).toISOString();
    expect(formatStatusEvidence(base({ claims: { count: 1, asOf: old } }))).toContain(`stale (as of ${old})`);
  });
  it('says unknown for missing facts', () => {
    const out = formatStatusEvidence(base({ runtime: null, claims: null, owner: null, state: null }));
    expect(out).toContain('Status: RECEIVED');
    expect(out).toContain('Runtime: unknown');
    expect(out).toContain('Claims: unknown');
    expect(out).toContain('Bridge owner: unknown');
    expect(formatStatusEvidence(base({ runtime: { host: null, version: null, pid: null, asOf: null } }))).toContain('host unknown, version unknown, pid unknown · as of unknown');
  });
  it('redacts tokens, credentialed URLs and home paths', () => {
    const out = formatStatusEvidence(base({
      runtime: { host: '/Users/someone/x', version: 'ghp_FAKEFAKEFAKE', pid: 1, asOf: fresh },
      owner: { name: 'fake-owner', receipt: 'https://user:fakepw@example.test/r', artifact: null, asOf: fresh },
    }));
    expect(out).toContain('~/x');
    expect(out).not.toContain('someone');
    expect(out).not.toContain('ghp_FAKEFAKEFAKE');
    expect(out).not.toContain('fakepw');
  });
});
