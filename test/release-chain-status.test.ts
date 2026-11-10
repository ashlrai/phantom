import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdFleetReleaseChain } from '../src/cli/fleet-release-chain.js';
import { readReleaseChainStatus } from '../src/core/fleet/release-chain-status.js';

interface Fixture { root: string; sign: string; autorun: string }

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'release-chain-'));
  const sign = join(root, 'release-sign');
  const autorun = join(sign, 'autorun');
  mkdirSync(autorun, { recursive: true });
  return { root, sign, autorun };
}

function writeRc(f: Fixture, sha: string, rc: string, mtime: Date): string {
  const path = join(f.autorun, `sha-${sha}.rc`);
  writeFileSync(path, `${rc}\n`);
  utimesSync(path, mtime, mtime);
  return path;
}

function writeLog(f: Fixture, name: string, text: string, mtime: Date): string {
  const path = join(f.sign, name);
  writeFileSync(path, text);
  utimesSync(path, mtime, mtime);
  return path;
}

const T1 = new Date('2026-11-08T14:22:10.000Z');
const T2 = new Date('2026-11-09T02:10:00.000Z');

describe('readReleaseChainStatus', () => {
  it('reports unknown when release-sign is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-chain-empty-'));
    try {
      const status = readReleaseChainStatus({ runsDir: root, installedVersion: '3.29.15' });
      expect(status).toEqual({
        latestAutorun: null, reason: null, version: null,
        installedVersion: '3.29.15', verdict: 'unknown', sources: [],
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports published when the newest rc is 0', () => {
    const f = fixture();
    try {
      const rc = writeRc(f, 'aaaaaaaaaaaa', '0', T1);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.verdict).toBe('published');
      expect(status.latestAutorun).toEqual({ sha: 'aaaaaaaaaaaa', rc: 0, mtime: T1.toISOString() });
      expect(status.sources).toEqual([rc]);
      expect(status.reason).toBeNull();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('reports held with the Reason line of the newest run log', () => {
    const f = fixture();
    try {
      const rc = writeRc(f, 'bbbbbbbbbbbb', '12', T2);
      const log = writeLog(f, 'v3.30.8-1762540000.log',
        'START v3.30.8 bbbbbbbbbbbb\nreason: ignored lowercase\n  Reason: Desktop update finalization held\nEND rc=12\n', T2);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.verdict).toBe('held');
      expect(status.reason).toBe('Reason: Desktop update finalization held');
      expect(status.version).toBe('3.30.8');
      expect(status.sources).toEqual([rc, log]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('falls back to the last held line when no Reason line exists', () => {
    const f = fixture();
    try {
      writeRc(f, 'bbbbbbbbbbbb', '12', T2);
      writeLog(f, 'v3.30.8-1762540000.log',
        'signing…\nDesktop update finalization held; no feed was published. Phase: sign-app\n', T2);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.verdict).toBe('held');
      expect(status.reason).toBe('Desktop update finalization held; no feed was published. Phase: sign-app');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('reports failed on a non-zero rc other than 12', () => {
    const f = fixture();
    try {
      writeRc(f, 'cccccccccccc', '3', T1);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.verdict).toBe('failed');
      expect(status.latestAutorun?.rc).toBe(3);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('lets the newest marker by mtime win', () => {
    const f = fixture();
    try {
      writeRc(f, 'dddddddddddd', '0', T1);
      writeRc(f, 'eeeeeeeeeeee', '12', T2);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.latestAutorun?.sha).toBe('eeeeeeeeeeee');
      expect(status.verdict).toBe('held');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('reads a non-numeric rc as unknown rather than throwing', () => {
    const f = fixture();
    try {
      writeRc(f, 'ffffffffffff', 'not-a-number', T1);
      const status = readReleaseChainStatus({ runsDir: f.root });
      expect(status.latestAutorun?.rc).toBeNull();
      expect(status.verdict).toBe('unknown');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe('cmdFleetReleaseChain', () => {
  it('prints the status object under --json', async () => {
    const f = fixture();
    const output: string[] = [];
    try {
      writeRc(f, 'aaaaaaaaaaaa', '0', T1);
      const code = await cmdFleetReleaseChain(['--json', '--runs-dir', f.root], {
        installedVersion: () => '3.29.15', output: text => output.push(text),
      });
      expect(code).toBe(0);
      expect(JSON.parse(output[0]!)).toMatchObject({
        latestAutorun: { sha: 'aaaaaaaaaaaa', rc: 0, mtime: T1.toISOString() },
        reason: null, version: null, installedVersion: '3.29.15', verdict: 'published',
      });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('puts the verdict first in human output', async () => {
    const f = fixture();
    const output: string[] = [];
    try {
      writeRc(f, 'bbbbbbbbbbbb', '12', T2);
      writeLog(f, 'v3.30.8-1762540000.log', 'Reason: Desktop update finalization held\n', T2);
      const code = await cmdFleetReleaseChain(['--runs-dir', f.root], {
        installedVersion: () => null, output: text => output.push(text),
      });
      expect(code).toBe(0);
      const lines = output[0]!.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines.length).toBeLessThanOrEqual(5);
      expect(lines[0]).toContain('held: v3.30.8 rc=12');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
