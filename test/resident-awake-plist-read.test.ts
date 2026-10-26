import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rename, writeFile } from 'node:fs/promises';

const hooks = vi.hoisted(() => ({ afterOpen: null as (() => Promise<void>) | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    await hooks.afterOpen?.();
    return handle;
  } };
});

import { readInstalledResidentPlist } from '../src/core/verse/control-api.js';
import { generateServiceDefinition } from '../src/core/daemon/service.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'resident-awake-plist-')); hooks.afterOpen = null; });
afterEach(() => { hooks.afterOpen = null; rmSync(directory, { recursive: true, force: true }); });

function plist(keepAwake: boolean): string {
  return generateServiceDefinition({ platform: 'darwin', homeDir: directory, keepAwake }).content;
}

describe('installed resident plist read', () => {
  it('reads a bounded pinned regular plist and treats missing as absent', async () => {
    const file = join(directory, 'service.plist');
    expect(await readInstalledResidentPlist(file)).toEqual({ serviceInstalled: false, installed: null });
    writeFileSync(file, plist(false));
    expect(await readInstalledResidentPlist(file)).toEqual({ serviceInstalled: true, installed: false });
    writeFileSync(file, plist(true));
    expect(await readInstalledResidentPlist(file)).toEqual({ serviceInstalled: true, installed: true });
  });

  it('refuses a symlink or oversized plist', async () => {
    const target = join(directory, 'target.plist');
    const link = join(directory, 'service.plist');
    writeFileSync(target, plist(true));
    symlinkSync(target, link);
    expect(await readInstalledResidentPlist(link)).toEqual({ serviceInstalled: null, installed: null });
    rmSync(link);
    writeFileSync(link, 'x'.repeat(64 * 1024 + 1));
    expect(await readInstalledResidentPlist(link)).toEqual({ serviceInstalled: null, installed: null });
  });

  it('returns unknown when the pathname is replaced after the no-follow descriptor opens', async () => {
    const file = join(directory, 'service.plist');
    writeFileSync(file, plist(false));
    hooks.afterOpen = async () => {
      await rename(file, `${file}.old`);
      await writeFile(file, plist(true));
    };
    expect(await readInstalledResidentPlist(file)).toEqual({ serviceInstalled: null, installed: null });
  });
});
