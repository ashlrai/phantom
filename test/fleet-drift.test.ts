import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleetDrift, notLiveLine } from '../src/core/fleet/drift.js';
import { planFleetSync } from '../src/core/fleet/sync-plan.js';
import { cmdFleetDrift } from '../src/cli/fleet-drift.js';
import { cmdFleetSync } from '../src/cli/fleet-sync.js';
import { buildStatusDigest } from '../src/core/leader/status-digest.js';

let root = '';
afterEach(async () => { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }); });

const CHANGED = '2026-11-10T12:00:00Z';
const lastChange = async (_repo: string, source: string) => source === 'scripts/nodate.sh' ? null : CHANGED;

async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'fleet-drift-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  await mkdir(join(repo, 'fleet'), { recursive: true });
  await mkdir(join(repo, 'scripts'));
  await mkdir(bin);
  const entries = [
    { src: 'scripts/same.sh', class: 'managed' },
    { src: 'scripts/old.sh', class: 'managed' },
    { src: 'scripts/hotfix.sh', class: 'managed' },
    { src: 'scripts/absent.py', class: 'managed' },
    { src: 'scripts/broken.sh', class: 'managed' },
    { src: 'scripts/pinned.sh', class: 'pinned' },
    { src: 'scripts/sha.sh', class: 'managed', sha256: 'a'.repeat(64) },
    { src: 'scripts/sandbox.sb', class: 'managed' },
    { src: 'scripts/leader-wrap.sh', class: 'managed' },
    { src: 'scripts/publish-it.sh', class: 'managed' },
    { src: 'scripts/nodate.sh', class: 'managed' },
    { name: 'extra.sh', class: 'manual' },
    { name: 'gone.sh', class: 'manual' },
  ].map(e => ({ root: 'runs-bin', ...e }));
  await writeFile(join(repo, 'fleet/manifest.json'), JSON.stringify({ files: entries }));
  const good = '#!/bin/bash\necho new\n';
  for (const name of ['same.sh', 'old.sh', 'hotfix.sh', 'pinned.sh', 'sha.sh', 'sandbox.sb', 'leader-wrap.sh', 'publish-it.sh', 'nodate.sh']) await writeFile(join(repo, 'scripts', name), good);
  await writeFile(join(repo, 'scripts/absent.py'), 'print("hi")\n');
  await writeFile(join(repo, 'scripts/broken.sh'), 'if then fi (\n');
  for (const name of ['same.sh']) await writeFile(join(bin, name), good);
  const older = new Date('2026-11-01T00:00:00Z');
  for (const name of ['old.sh', 'pinned.sh', 'sha.sh', 'sandbox.sb', 'leader-wrap.sh', 'publish-it.sh', 'broken.sh', 'nodate.sh']) {
    await writeFile(join(bin, name), 'old\n');
    await utimes(join(bin, name), older, older);
  }
  await writeFile(join(bin, 'hotfix.sh'), 'edited on the host\n');
  await utimes(join(bin, 'hotfix.sh'), new Date('2026-11-15T00:00:00Z'), new Date('2026-11-15T00:00:00Z'));
  await writeFile(join(bin, 'extra.sh'), 'host only\n');
  return { repo, bin };
}

const snapshot = async (dir: string) => Promise.all((await readdir(dir)).sort().map(async n => [n, await readFile(join(dir, n), 'utf8')]));

describe('fleet drift', () => {
  it('reports each state with the newest repo change date and writes nothing', async () => {
    const { repo, bin } = await fixture();
    const before = await snapshot(bin);
    const report = await fleetDrift(repo, bin, { lastChange, now: () => new Date('2026-11-19T00:00:00Z') });
    const by = Object.fromEntries(report.files.map(f => [f.file, f]));
    expect(report.schema).toBe('fleet.drift.v1');
    expect(by['same.sh']!.state).toBe('same');
    expect(by['old.sh']).toMatchObject({ state: 'repo_newer', repoChangedAt: CHANGED });
    expect(by['hotfix.sh']!.state).toBe('live_only');
    expect(by['extra.sh']).toMatchObject({ state: 'live_only', source: null, sourceSha256: null });
    expect(by['absent.py']!.state).toBe('missing');
    expect(by['gone.sh']!.state).toBe('missing');
    expect(by['nodate.sh']).toMatchObject({ state: 'repo_newer', repoChangedAt: null });
    expect(report.counts).toEqual({ same: 1, repo_newer: 8, live_only: 2, missing: 2 });
    expect(report.notLive).toBe(report.files.length - 1);
    expect(await snapshot(bin)).toEqual(before);
  });

  it('prints plain words and typed JSON with a schema id', async () => {
    const { repo, bin } = await fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetDrift(['--repo', repo, '--bin', bin])).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/^Fleet files: 1 live, 9 not live yet, 2 missing, 1 live only\.$/);
    expect(log.mock.calls.at(-1)?.[0]).toBe('Next: phm fleet sync --dry-run');
    log.mockClear();
    expect(await cmdFleetDrift(['--repo', repo, '--bin', bin, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).schema).toBe('fleet.drift.v1');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetDrift(['--bogus'])).toBe(2);
  });

  it('adds a "Not live yet" digest line only when merged files are not installed', async () => {
    const { repo, bin } = await fixture();
    const report = await fleetDrift(repo, bin, { lastChange });
    const line = notLiveLine(report)!;
    expect(line).toMatch(/^Not live yet: \d+ merged fleet files \(.+\)\. Run phm fleet drift\.$/);
    expect(notLiveLine({ ...report, files: report.files.filter(f => f.state === 'same') })).toBeNull();
    const digest = buildStatusDigest({
      installedVersion: { ok: true, value: '1' }, publishedVersion: { ok: true, value: '1' }, updatePending: false,
      mergesLastHour: { ok: true, value: 0 }, mergesLast24h: { ok: true, value: 0 }, lanes: { ok: true, value: [] },
      needsMason: { ok: true, value: 0 }, topP0: { ok: true, value: null }, notLiveLine: line,
    });
    expect(digest).toContain(line);
  });
});

describe('fleet sync --dry-run', () => {
  it('plans backups and checks, skips protected files and bad syntax, and never writes', async () => {
    const { repo, bin } = await fixture();
    const before = await snapshot(bin);
    const report = await fleetDrift(repo, bin, { lastChange, now: () => new Date('2026-11-19T01:02:03Z') });
    const plan = await planFleetSync(report);
    const by = Object.fromEntries(plan.rows.map(r => [r.file, r]));
    expect(plan.schema).toBe('fleet.sync-plan.v1');
    expect(plan.dryRun).toBe(true);
    expect(by['same.sh']).toBeUndefined();
    expect(by['old.sh']!.action).toBe('copy');
    expect(by['old.sh']!.steps.map(s => s.step)).toEqual(['backup', 'syntax', 'copy', 'verify']);
    expect(by['old.sh']!.steps[0]!.detail).toContain('.bak-fleet-20261119T010203Z');
    expect(by['absent.py']!.steps.map(s => s.step)).toEqual(['syntax', 'copy', 'verify']);
    expect(by['broken.sh']).toMatchObject({ action: 'skip' });
    expect(by['broken.sh']!.reason).toContain('syntax check failed');
    for (const name of ['pinned.sh', 'sha.sh', 'sandbox.sb', 'leader-wrap.sh', 'publish-it.sh']) {
      expect(by[name]!.action, name).toBe('skip');
      expect(by[name]!.reason, name).toContain('protected');
      expect(by[name]!.steps, name).toEqual([]);
    }
    expect(by['hotfix.sh']!.action).toBe('skip');
    expect(by['extra.sh']!.action).toBe('skip');
    expect(await snapshot(bin)).toEqual(before);
  });

  it('flags a bad Python file and requires --dry-run', async () => {
    const { repo, bin } = await fixture();
    await writeFile(join(repo, 'scripts/absent.py'), 'def (:\n');
    const plan = await planFleetSync(await fleetDrift(repo, bin, { lastChange }));
    expect(plan.rows.find(r => r.file === 'absent.py')!.reason).toContain('syntax check failed');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetSync(['--repo', repo, '--bin', bin])).toBe(2);
    expect(String(err.mock.calls[0]?.[0])).toContain('--dry-run');
    expect(await cmdFleetSync(['--repo', repo, '--bin', bin, '--dry-run', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).schema).toBe('fleet.sync-plan.v1');
  });
});
