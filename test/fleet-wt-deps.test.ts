import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetWtDeps, inspectWtDeps } from '../src/cli/fleet-wt-deps.js';

const roots: string[] = [];
async function tree(): Promise<string> { const p = await mkdtemp(join(tmpdir(), 'wt-deps-')); roots.push(p); return p; }
async function json(path: string, value: unknown) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
async function pkg(root: string, name: string, value: unknown) { await json(join(root, 'node_modules', name, 'package.json'), value); }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

describe('fleet wt-deps', () => {
  it('detects missing scoped and uninstalled dependencies and deduplicates targets', async () => {
    const dir = await tree();
    await json(join(dir, 'package.json'), { dependencies: { '@scope/a': '*', absent: '*' }, devDependencies: { '@scope/a': '*' } });
    await pkg(dir, '@scope/a', { version: '1', main: 'lib/cli.js', bin: { a: 'lib/cli.js' } });
    const report = await inspectWtDeps(dir, null, false);
    expect(report.packages.map(p => p.name)).toEqual(['@scope/a', 'absent']);
    expect(report.packages[0]!.missing).toEqual([{ path: 'lib/cli.js', donor: false, copied: false }]);
    expect(report.packages[1]!.error).toBeTruthy();
  });
  it('plans and applies only same-version donor files', async () => {
    const dir = await tree(), donor = await tree();
    await json(join(dir, 'package.json'), { devDependencies: { a: '*', b: '*' } });
    for (const name of ['a', 'b']) {
      await pkg(dir, name, { version: '1', bin: 'bin/run.js' });
      await pkg(donor, name, { version: name === 'a' ? '1' : '2' });
      const file = join(donor, 'node_modules', name, 'bin/run.js'); await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, name);
    }
    const planned = await inspectWtDeps(dir, donor, false);
    expect(planned.packages.map(p => p.missing[0]!.donor)).toEqual([true, false]);
    const applied = await inspectWtDeps(dir, donor, true);
    expect(applied.packages[0]!.missing[0]!.copied).toBe(true);
    expect(await readFile(join(dir, 'node_modules/a/bin/run.js'), 'utf8')).toBe('a');
    expect((await inspectWtDeps(dir, donor, false)).packages.map(p => p.name)).toEqual(['b']);
  });
  it('rejects escaping targets and donor symlinks', async () => {
    const dir = await tree(), donor = await tree();
    await json(join(dir, 'package.json'), { dependencies: { a: '*' } });
    await pkg(dir, 'a', { version: '1', main: '../escape', bin: 'bin/run' });
    await pkg(donor, 'a', { version: '1' });
    await writeFile(join(donor, 'outside'), 'no');
    await mkdir(join(donor, 'node_modules/a/bin'));
    await symlink(join(donor, 'outside'), join(donor, 'node_modules/a/bin/run'));
    const report = await inspectWtDeps(dir, donor, true);
    expect(report.packages[0]!.missing.every(m => !m.copied)).toBe(true);
  });
  it('returns status and JSON through the CLI', async () => {
    const dir = await tree(); await json(join(dir, 'package.json'), { dependencies: { a: '*' } });
    let output = ''; vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { output += s; return true; }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetWtDeps(['--dir', dir, '--json'])).toBe(1);
    expect(JSON.parse(output).packages[0].name).toBe('a');
    expect(await cmdFleetWtDeps(['--apply'])).toBe(2);
    await pkg(dir, 'a', { version: '1' });
    expect(await cmdFleetWtDeps(['--dir', dir, '--json'])).toBe(0);
  });
});
