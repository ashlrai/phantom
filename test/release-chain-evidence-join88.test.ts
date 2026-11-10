/**
 * RQ-PHX-RELEASEEVIDENCEJOIN88 — release-chain evidence join.
 *
 * `readReleaseChainStatus` must not let unrelated signing evidence pose as
 * the selected run's outcome: version/reason attach to the newest
 * `sha-<sha>.rc` only through a durable record (a `feed-<sha>.json` receipt
 * bound to that sha, or a `v*.log` START declaration naming it), and rc=0
 * maps to `published` only with a `feed-<sha>.rc` published-state proof.
 * All fixtures are fake; cmdFleetReleaseChain runs against a temp runs-dir
 * with a stubbed installed-version reader.
 */

import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdFleetReleaseChain } from '../src/cli/fleet-release-chain.js';
import { readReleaseChainStatus } from '../src/core/fleet/release-chain-status.js';

interface Fixture { root: string; sign: string; autorun: string }

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'release-chain-join88-'));
  const sign = join(root, 'release-sign');
  const autorun = join(sign, 'autorun');
  mkdirSync(autorun, { recursive: true });
  return { root, sign, autorun };
}

function stamp(path: string, mtime: Date): string {
  utimesSync(path, mtime, mtime);
  return path;
}

function writeRc(f: Fixture, sha: string, rc: string, mtime: Date): string {
  const path = join(f.autorun, `sha-${sha}.rc`);
  writeFileSync(path, `${rc}\n`);
  return stamp(path, mtime);
}

function writeFeedRc(f: Fixture, sha: string, rc: string, mtime: Date): string {
  const path = join(f.autorun, `feed-${sha}.rc`);
  writeFileSync(path, `${rc}\n`);
  return stamp(path, mtime);
}

function writeFeedJson(f: Fixture, sha: string, doc: unknown, mtime: Date): string {
  const path = join(f.autorun, `feed-${sha}.json`);
  writeFileSync(path, `${JSON.stringify(doc)}\n`);
  return stamp(path, mtime);
}

function writeLog(f: Fixture, name: string, text: string, mtime: Date): string {
  const path = join(f.sign, name);
  writeFileSync(path, text);
  return stamp(path, mtime);
}

const T1 = new Date('2026-11-08T14:22:10.000Z');
const T2 = new Date('2026-11-09T02:10:00.000Z');
const T3 = new Date('2026-11-09T09:30:00.000Z');

const SHA_A = 'aaaaaaaaaaaabbbbbbbbbbbbccccccccccccdddddddd';
const SHA_B = 'eeeeeeeeeeeeffffffffffff000000001111111111';
const SHA_C = '999999999999888888888888777777776666666666';

function feedDoc(state: string, sha: string, tag: string, extra: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1, kind: 'desktop-update-channel-check', state,
    sha, tag, checkedAt: '2026-11-09T10:00:00Z', ...extra,
  };
}

describe('readReleaseChainStatus evidence join', () => {
  it('keeps competing sha runs apart: version and reason come from the selected sha only', () => {
    const f = fixture();
    try {
      // Older run for SHA_A published v3.30.7; newer run for SHA_B held v3.30.8.
      writeRc(f, SHA_A, '0', T1);
      writeFeedRc(f, SHA_A, '0', T1);
      writeFeedJson(f, SHA_A, feedDoc('verified-live', SHA_A, 'v3.30.7', {
        releaseId: 111, latestTag: 'v3.30.8', endpointHttp: 200,
        feedSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64),
      }), T1);
      writeLog(f, 'v3.30.7-1762500000.log',
        `START v3.30.7 ${SHA_A.slice(0, 12)}\nEND rc=0\n`, T1);
      writeRc(f, SHA_B, '12', T3);
      writeLog(f, 'v3.30.8-1762540000.log',
        `START v3.30.8 ${SHA_B.slice(0, 12)}\n  Reason: Desktop update finalization held\nEND rc=12\n`, T3);
      // An unrelated newer log for a third sha must never be attached.
      writeLog(f, 'v3.30.9-1762600000.log',
        `START v3.30.9 ${SHA_C.slice(0, 12)}\n  Reason: unrelated failure text\n`, T3);

      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.latestAutorun?.sha).toBe(SHA_B);
      expect(status.verdict).toBe('held');
      expect(status.version).toBe('3.30.8');
      expect(status.reason).toBe('Reason: Desktop update finalization held');
      expect(status.evidence.versionJoin).toBe('log-field');
      expect(status.evidence.boundLog).toBe('v3.30.8-1762540000.log');
      expect(status.sources.some(p => p.includes('v3.30.9'))).toBe(false);
      expect(status.sources.some(p => p.includes('v3.30.7'))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('ignores a newer log that does not declare the selected sha', () => {
    const f = fixture();
    try {
      writeRc(f, SHA_B, '12', T2);
      writeLog(f, 'v3.30.8-1762540000.log',
        'signing output without any declaration\nReason: possibly related but unproven\n', T1);
      writeLog(f, 'v9.9.9-1762600000.log',
        `START v9.9.9 ${SHA_C.slice(0, 12)}\nReason: newest unrelated run\n`, T3);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.verdict).toBe('held');
      expect(status.version).toBeNull();
      expect(status.reason).toBeNull();
      expect(status.evidence.boundLog).toBeNull();
      expect(status.evidence.versionJoin).toBe('none');
      expect(status.evidence.diagnostics.join(' ')).toContain('do not prove a join');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('does not bind a log whose declared version differs from its file name', () => {
    const f = fixture();
    try {
      writeRc(f, SHA_B, '12', T2);
      writeLog(f, 'v3.30.8-1762540000.log',
        `START v3.30.9 ${SHA_B.slice(0, 12)}\nReason: version mismatch\n`, T2);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.verdict).toBe('held');
      expect(status.version).toBeNull();
      expect(status.reason).toBeNull();
      expect(status.evidence.boundLog).toBeNull();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('reports rc=0 without a feed marker as unknown, never published', () => {
    const f = fixture();
    try {
      writeRc(f, SHA_B, '0', T2);
      writeLog(f, 'v3.30.8-1762540000.log',
        `START v3.30.8 ${SHA_B.slice(0, 12)}\nReason: signed ok\n`, T2);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.verdict).toBe('unknown');
      expect(status.latestAutorun?.rc).toBe(0);
      expect(status.evidence.feedRc).toBeNull();
      expect(status.evidence.diagnostics.join(' ')).toContain('publication unproven');
      // The bound log may still prove version/reason for the signing run.
      expect(status.version).toBe('3.30.8');
      expect(status.reason).toBe('Reason: signed ok');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('maps feed rc 22 to failed with the receipt reason', () => {
    const f = fixture();
    try {
      writeRc(f, SHA_B, '0', T2);
      writeFeedRc(f, SHA_B, '22', T3);
      writeFeedJson(f, SHA_B, feedDoc('failed', SHA_B, 'v3.30.8', {
        reason: 'endpoint-mismatch',
      }), T3);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.verdict).toBe('failed');
      expect(status.evidence.feedRc).toBe(22);
      expect(status.evidence.feedState).toBe('failed');
      expect(status.version).toBe('3.30.8');
      expect(status.reason).toBe('endpoint-mismatch');
      expect(status.evidence.versionJoin).toBe('feed-receipt');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('maps feed rc 21 to published as verified-but-superseded', () => {
    const f = fixture();
    try {
      writeRc(f, SHA_B, '0', T2);
      writeFeedRc(f, SHA_B, '21', T3);
      writeFeedJson(f, SHA_B, feedDoc('verified-but-superseded', SHA_B, 'v3.30.8', {
        releaseId: 222, latestTag: 'v3.30.9', endpointHttp: null,
        feedSha256: 'c'.repeat(64), manifestSha256: 'd'.repeat(64),
      }), T3);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.verdict).toBe('published');
      expect(status.evidence.feedState).toBe('verified-but-superseded');
      expect(status.version).toBe('3.30.8');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('ignores a feed receipt bound to a different sha', () => {
    const f = fixture();
    try {
      writeRc(f, SHA_B, '0', T2);
      writeFeedRc(f, SHA_B, '0', T3);
      writeFeedJson(f, SHA_B, feedDoc('verified-live', SHA_A, 'v3.30.7'), T3);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.verdict).toBe('published');
      expect(status.evidence.feedState).toBeNull();
      expect(status.version).toBeNull();
      expect(status.evidence.diagnostics.join(' ')).toContain('not bound to this sha');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('keeps held/failed status from its own rc without borrowing another run’s reason', () => {
    const f = fixture();
    try {
      writeRc(f, SHA_B, '3', T2);
      writeRc(f, SHA_C, '0', T1);
      writeFeedRc(f, SHA_C, '0', T1);
      writeFeedJson(f, SHA_C, feedDoc('verified-live', SHA_C, 'v3.30.7', {
        releaseId: 333, latestTag: 'v3.30.7', endpointHttp: 200,
        feedSha256: 'e'.repeat(64), manifestSha256: 'f'.repeat(64),
      }), T1);
      writeLog(f, 'v3.30.7-1762500000.log',
        `START v3.30.7 ${SHA_C.slice(0, 12)}\nReason: earlier run noise\n`, T1);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.latestAutorun?.sha).toBe(SHA_B);
      expect(status.verdict).toBe('failed');
      expect(status.reason).toBeNull();
      expect(status.version).toBeNull();
      expect(status.evidence.feedRc).toBeNull();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('reports malformed and missing markers as unknown', () => {
    const f = fixture();
    try {
      writeRc(f, SHA_B, 'not-a-number', T2);
      writeLog(f, 'v3.30.8-1762540000.log',
        `START v3.30.8 ${SHA_B.slice(0, 12)}\nReason: still readable\n`, T2);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.verdict).toBe('unknown');
      expect(status.latestAutorun?.rc).toBeNull();
      const empty = fixture();
      try {
        const none = readReleaseChainStatus({ runsDir: empty.root });
        expect(none.verdict).toBe('unknown');
        expect(none.latestAutorun).toBeNull();
      } finally { rmSync(empty.root, { recursive: true, force: true }); }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe('cmdFleetReleaseChain evidence honesty', () => {
  it('JSON does not claim published or a mismatched version for rc=0 without feed proof', async () => {
    const f = fixture();
    const output: string[] = [];
    try {
      writeRc(f, SHA_B, '0', T2);
      writeLog(f, 'v3.30.8-1762540000.log',
        `START v3.30.8 ${SHA_C.slice(0, 12)}\nReason: other run\n`, T3);
      const code = await cmdFleetReleaseChain(['--json', '--runs-dir', f.root], {
        installedVersion: () => '3.29.15', output: text => output.push(text),
      });
      expect(code).toBe(0);
      const status = JSON.parse(output[0]!);
      expect(status.verdict).toBe('unknown');
      expect(status.version).toBeNull();
      expect(status.reason).toBeNull();
      expect(status.evidence.feedRc).toBeNull();
      expect(status.installedVersion).toBe('3.29.15');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('text output does not print a mismatched version or published claim', async () => {
    const f = fixture();
    const output: string[] = [];
    try {
      writeRc(f, SHA_B, '0', T2);
      writeLog(f, 'v9.9.9-1762600000.log',
        `START v9.9.9 ${SHA_C.slice(0, 12)}\nReason: unrelated\n`, T3);
      const code = await cmdFleetReleaseChain(['--runs-dir', f.root], {
        installedVersion: () => null, output: text => output.push(text),
      });
      expect(code).toBe(0);
      const text = output[0]!;
      expect(text).toContain('unknown:');
      expect(text).toContain('version-unknown');
      expect(text).not.toContain('v9.9.9');
      expect(text).not.toContain('published');
      expect(text).not.toContain('unrelated');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
