import { readFileSync } from 'node:fs';
import { readFile, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDriveReport, parseDriveInputs } from '../src/core/drive/routines.js';
import { driveMacJobs } from '../src/core/drive/mac-jobs.js';
import { cmdDrive } from '../src/cli/drive.js';
import { cmdFleet } from '../src/cli/fleet.js';

vi.mock('../src/core/fleet/digest.js', () => ({ buildFleetDigest: vi.fn(async () => ({ totalPending: 2 })) }));
const statusText = readFileSync(new URL('./fixtures/drive/status.json', import.meta.url), 'utf8');
const jobsText = readFileSync(new URL('./fixtures/drive/jobs.jsonl', import.meta.url), 'utf8');
const now = new Date('2026-10-26T14:00:00Z');
afterEach(() => vi.restoreAllMocks());

describe('drive routines', () => {
  it('produces health, top three levers and PR links from driver fixtures', () => {
    const { status, jobs } = parseDriveInputs(statusText, jobsText);
    const report = buildDriveReport(status, jobs, now);
    expect(report.health).toEqual(['Main checks: red', 'Stuck job: stuck', 'Empty lane: mac']);
    expect(report.levers.map(lever => lever.id)).toEqual(['main', 'stuck', 'empty']);
    expect(report.prLinks).toEqual(['https://github.com/ashlrai/phantom/pull/42']);
    expect(jobs).toHaveLength(4);
  });

  it('reports stale and future snapshots and keeps healthy lanes quiet', () => {
    const { status } = parseDriveInputs(statusText, '');
    const healthy = { ...status, main: 'green' as const, lanes: [] };
    expect(buildDriveReport(healthy, [], now).health).toEqual([]);
    expect(buildDriveReport(healthy, [], now).levers).toEqual([]);
    expect(buildDriveReport({ ...healthy, main: 'unknown' }, [], now).levers[0]?.id).toBe('main');
    expect(buildDriveReport(healthy, [], new Date('2026-10-26T15:00:00Z')).levers[0]?.id).toBe('snapshot');
    expect(buildDriveReport(healthy, [], new Date('2026-10-26T15:00:00Z')).health).toContain('Driver status is stale or clock is ahead');
    expect(buildDriveReport(healthy, [], new Date('2026-10-26T13:00:00Z')).health).toContain('Driver status is stale or clock is ahead');
  });

  it.each(['null', '{}', '{"schemaVersion":2}', statusText.replace('"queued":0', '"queued":-1')])('rejects invalid status: %s', text => {
    expect(() => parseDriveInputs(text, jobsText)).toThrow();
  });

  it.each(['{', 'null', '{"id":"bad","state":"running","updatedAt":"invalid"}'])('rejects a corrupt journal: %s', text => {
    expect(() => parseDriveInputs(statusText, text)).toThrow();
  });

  it('generates a shell-free Mac recurring job with escaped paths', () => {
    const [job] = driveMacJobs('/opt/a&b/phm', '/tmp/drive <root>');
    expect(job!.plist).toContain('/opt/a&amp;b/phm');
    expect(job!.plist).toContain('/tmp/drive &lt;root&gt;');
    expect(job!.plist).toContain('<integer>300</integer>');
    expect(job!.plist).toContain('<string>drive</string><string>report</string><string>--once</string>');
    expect(job!.plist).not.toContain('/bin/sh');
  });

  it('writes a private relay file and exposes matching drive levers output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drive-test-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await writeFile(join(root, 'status.json'), statusText);
      await writeFile(join(root, 'jobs.jsonl'), jobsText);
      expect(await cmdDrive(['report', '--root', root, '--once', '--json'])).toBe(0);
      const saved = await readFile(join(root, 'relay-status.json'), 'utf8');
      const output = JSON.parse(saved);
      expect(output.fleet.totalPending).toBe(2);
      expect(output.prLinks).toEqual(['https://github.com/ashlrai/phantom/pull/42']);
      if (process.platform !== 'win32') expect((await stat(join(root, 'relay-status.json'))).mode & 0o777).toBe(0o600);
      expect(await cmdDrive(['levers', '--root', root, '--json'])).toBe(0);
      expect(JSON.parse(log.mock.calls.at(-1)![0]).levers).toEqual(output.levers);
      expect(await cmdFleet(['drive', '--root', root, '--json'])).toBe(0);
      expect(JSON.parse(log.mock.calls.at(-1)![0]).prLinks).toEqual(output.prLinks);
      const refreshed = await readFile(join(root, 'relay-status.json'), 'utf8');
      await writeFile(join(root, 'jobs.jsonl'), '{broken');
      expect(await cmdDrive(['report', '--root', root])).toBe(1);
      expect(await readFile(join(root, 'relay-status.json'), 'utf8')).toBe(refreshed);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('help and invalid flags do not write state', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdDrive(['report', '--help'])).toBe(0);
    expect(await cmdDrive(['report', '--send'])).toBe(2);
    expect(await cmdDrive(['jobs', '--bin', 'relative'])).toBe(1);
    expect(await cmdDrive(['jobs', '--bin', '/opt/phm', '--root', '/tmp/drive'])).toBe(0);
    expect(await cmdDrive(['levers', '--root'])).toBe(2);
  });
});
