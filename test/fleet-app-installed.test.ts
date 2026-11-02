import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetApp, findAppControlScript, findInstalledAppControlScript, type FleetAppExecOptions } from '../src/cli/fleet-app.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'fleet-app-installed-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Mirror bridge-install: releases/<id>/app_control.py published through the `current` symlink. */
function install(root: string): string {
  const release = join(root, 'mac-bridge', 'releases', 'abc123abc123');
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, 'app_control.py'), 'print("{}")\n');
  symlinkSync(release, join(root, 'mac-bridge', 'current'));
  return join(release, 'app_control.py');
}

const okOut = JSON.stringify({ action: 'status', app: 'Cursor', ok: true, code: 'ok', running: true });
const run = (root: string, exec = vi.fn(async (_f: string, _a: readonly string[], _o: FleetAppExecOptions) => ({ stdout: okOut, stderr: '' }))) =>
  ({ exec, done: cmdFleetApp(['status', 'cursor', '--root', root], { exec, locateScript: () => null }) });

describe('fleet app installed script', () => {
  it('runs the installed copy under python3 -I when no checkout is found', async () => {
    const root = tmp();
    const script = install(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { exec, done } = run(root);
    expect(await done).toBe(0);
    const [file, argv] = exec.mock.calls[0]!;
    expect(file).toBe('python3');
    expect(argv.slice(0, 2)).toEqual(['-I', fs.realpathSync(script)]);
  });

  it('names both fixes on one line when neither script exists', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { exec, done } = run(tmp());
    expect(await done).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(err.mock.calls).toHaveLength(1);
    const line = String(err.mock.calls[0]![0]);
    expect(line).not.toContain('\n');
    expect(line).toContain('source checkout');
    expect(line).toContain('ashlr fleet bridge-install --apply');
  });

  it('refuses a current link that escapes mac-bridge', async () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'app_control.py'), 'print("evil")\n');
    mkdirSync(join(root, 'mac-bridge'), { recursive: true });
    symlinkSync(outside, join(root, 'mac-bridge', 'current'));
    expect(findInstalledAppControlScript(root)).toBeNull();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { exec, done } = run(root);
    expect(await done).toBe(1);
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses a file link that escapes and a non-regular file', () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'x.py'), '');
    mkdirSync(join(root, 'mac-bridge', 'current'), { recursive: true });
    symlinkSync(join(outside, 'x.py'), join(root, 'mac-bridge', 'current', 'app_control.py'));
    expect(findInstalledAppControlScript(root)).toBeNull();
    const root2 = tmp();
    mkdirSync(join(root2, 'mac-bridge', 'current', 'app_control.py'), { recursive: true });
    expect(findInstalledAppControlScript(root2)).toBeNull();
  });

  it('keeps the checkout script working and needs no sibling imports', () => {
    expect(findAppControlScript()).toMatch(/app_control\.py$/);
    const src = fs.readFileSync(findAppControlScript()!, 'utf8') as string;
    const local = [...src.matchAll(/^(?:from|import)\s+(\w+)/gm)].map(m => m[1]!)
      .filter(m => fs.existsSync(join(findAppControlScript()!, '..', `${m}.py`)));
    expect(local).toEqual([]);
  });
});
