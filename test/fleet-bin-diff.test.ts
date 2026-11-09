import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleetBinDiff } from '../src/core/fleet/bin-diff.js';
import { cmdFleetBinDiff } from '../src/cli/fleet-bin-diff.js';

let root = '';
afterEach(async () => { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }); });

describe('fleet bin-diff', () => {
  it('reports each state and leaves both trees untouched', async () => {
    root = await mkdtemp(join(tmpdir(), 'bin-diff-'));
    const repo = join(root, 'repo');
    const bin = join(root, 'bin');
    await mkdir(join(repo, 'fleet'), { recursive: true });
    await mkdir(join(repo, 'scripts'));
    await mkdir(bin);
    const names = ['same', 'changed', 'absent', 'protected'];
    await writeFile(join(repo, 'fleet/manifest.json'), JSON.stringify({ files: names.map(name => ({ root: 'runs-bin', src: `scripts/${name}`, class: 'managed' })) }));
    for (const name of names) await writeFile(join(repo, 'scripts', name), 'source');
    await writeFile(join(bin, 'same'), 'source');
    await writeFile(join(bin, 'changed'), 'old');
    await writeFile(join(bin, 'protected'), 'old');
    const pins = join(bin, 'SHA256SUMS');
    await writeFile(pins, `${'a'.repeat(64)}  protected\n`);
    const before = await Promise.all((await readdir(bin)).map(async name => [name, await readFile(join(bin, name), 'utf8')]));
    const report = await fleetBinDiff(repo, bin, pins);
    expect(report.files.map(row => row.status)).toEqual(['in-sync', 'drifted', 'missing', 'pinned']);
    expect(report.counts).toEqual({ 'in-sync': 1, drifted: 1, missing: 1, pinned: 1 });
    expect(report.files[3]?.sourceSha256).not.toEqual(report.files[3]?.liveSha256);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetBinDiff(['--repo', repo, '--bin', bin])).toBe(0);
    expect(log).toHaveBeenCalledWith('Fleet scripts: 1 in sync, 1 drifted, 1 missing, 1 pinned.');
    expect(await cmdFleetBinDiff(['--repo', repo, '--bin', bin, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.lastCall?.[0])).counts).toEqual(report.counts);
    expect(await Promise.all((await readdir(bin)).map(async name => [name, await readFile(join(bin, name), 'utf8')]))).toEqual(before);
  });
});
