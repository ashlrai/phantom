import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdResource } from '../src/cli/resource.js';
import { readResourceView, resourceViewDirectory, writeResourceView } from '../src/core/fabric/resource-view-store.js';

const NOW = Date.parse('2026-11-25T18:00:00.000Z');
const roots: string[] = [];
const originalAshlrHome = process.env['ASHLR_HOME'];

afterEach(() => {
  vi.restoreAllMocks();
  if (originalAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = originalAshlrHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resource-view-store-')));
  roots.push(root);
  return root;
}

function dirLinkType(): 'junction' | 'dir' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

function captureCliOutput(): { stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  return { stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('resourceViewDirectory and ASHLR_HOME isolation', () => {
  it('honors an absolute ASHLR_HOME and falls back to ~/.ashlr when unset, blank or relative', () => {
    const custom = join(scratchRoot(), 'custom-ashlr');
    process.env['ASHLR_HOME'] = custom;
    expect(resourceViewDirectory()).toBe(custom);

    for (const invalid of [undefined, '', '   ', 'relative/ashlr']) {
      if (invalid === undefined) delete process.env['ASHLR_HOME'];
      else process.env['ASHLR_HOME'] = invalid;
      expect(resourceViewDirectory()).toBe(join(homedir(), '.ashlr'));
    }
  });

  it('writes and reads fleet.json under ASHLR_HOME without touching HOME/.ashlr', async () => {
    const root = scratchRoot();
    const customHome = join(root, 'isolated-ashlr');
    mkdirSync(customHome, { mode: 0o700 });
    const homeAshlr = join(homedir(), '.ashlr');
    const homeFleetExistedBefore = existsSync(join(homeAshlr, 'fleet.json'));

    writeFileSync(join(customHome, 'fleet.json'), JSON.stringify({
      readings: {
        'codex-personal': {
          pool: 'codex-personal', pctUsed: 35,
          fetchedAt: new Date(NOW - 1_000).toISOString(),
          resetAt: new Date(NOW + 3_600_000).toISOString(),
          source: 'codex-personal-reader', burnRatePctPerHour: 10,
        },
      },
    }), { mode: 0o600 });

    process.env['ASHLR_HOME'] = customHome;
    const written = writeResourceView(undefined, NOW);
    expect(written.pools.find(p => p.pool === 'codex-personal')?.pctUsed).toBe(35);
    expect(existsSync(join(customHome, 'fleet.json'))).toBe(true);
    expect(existsSync(join(homeAshlr, 'fleet.json'))).toBe(homeFleetExistedBefore);

    const read = await readResourceView(undefined, NOW, join(root, 'missing-runs'), async () => ({ status: 'unknown', reason: 'missing-key' }));
    expect(read.pools.find(p => p.pool === 'codex-personal')?.pctUsed).toBe(35);
  });
});

describe('resource-view-store symlink and private-storage handling', () => {
  it('succeeds when an ancestor path traverses a symlink (e.g. macOS /var -> /private/var) while creating private storage', async () => {
    const root = scratchRoot();
    const realParent = join(root, 'real-parent');
    mkdirSync(realParent, { mode: 0o700 });
    const aliasParent = join(root, 'var-alias');
    symlinkSync(realParent, aliasParent, dirLinkType());

    // Brand-new leaf under symlinked ancestor (mirrors HOME=$(mktemp -d) on macOS)
    const freshAshlr = join(aliasParent, 'fresh-home', '.ashlr');
    const freshView = writeResourceView(freshAshlr, NOW);
    expect(freshView.schema).toBe('resource.v1');
    expect(freshView.pools.every(p => p.status === 'unknown' && p.pctUsed === null)).toBe(true);
    expect(existsSync(join(realParent, 'fresh-home', '.ashlr', 'fleet.json'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(join(realParent, 'fresh-home', '.ashlr')).mode & 0o777).toBe(0o700);
      expect(statSync(join(realParent, 'fresh-home', '.ashlr', 'fleet.json')).mode & 0o777).toBe(0o600);
    }

    // Existing 0700 directory reached through symlinked ancestor (mirrors ASHLR_HOME=$(mktemp -d) on macOS)
    const existingDir = join(realParent, 'existing-home');
    mkdirSync(existingDir, { mode: 0o700 });
    writeFileSync(join(existingDir, 'fleet.json'), JSON.stringify({
      readings: {
        'claude-max': {
          pool: 'claude-max', pctUsed: 22,
          fetchedAt: new Date(NOW - 1_000).toISOString(),
          resetAt: new Date(NOW + 3_600_000).toISOString(),
          source: 'claude-max-reader', burnRatePctPerHour: 5,
        },
      },
    }), { mode: 0o600 });

    const viaAlias = join(aliasParent, 'existing-home');
    const existingView = writeResourceView(viaAlias, NOW);
    expect(existingView.pools.find(p => p.pool === 'claude-max')?.pctUsed).toBe(22);

    const readBack = await readResourceView(viaAlias, NOW, join(root, 'no-runs'), async () => ({ status: 'unknown', reason: 'missing-key' }));
    expect(readBack.pools.find(p => p.pool === 'claude-max')?.pctUsed).toBe(22);
  });

  it('refuses a symlinked leaf directory on write and ignores it on read', async () => {
    const root = scratchRoot();
    const target = join(root, 'real-target');
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, 'fleet.json'), JSON.stringify({
      readings: {
        'codex-personal': {
          pool: 'codex-personal', pctUsed: 88,
          fetchedAt: new Date(NOW - 1_000).toISOString(),
          resetAt: new Date(NOW + 3_600_000).toISOString(),
          source: 'codex-personal-reader', burnRatePctPerHour: 0,
        },
      },
    }), { mode: 0o600 });

    const leafLink = join(root, 'leaf-link');
    symlinkSync(target, leafLink, dirLinkType());

    expect(() => writeResourceView(leafLink, NOW)).toThrow();
    expect(() => writeResourceView(`${leafLink}/`, NOW)).toThrow();

    const read = await readResourceView(leafLink, NOW, join(root, 'no-runs'), async () => ({ status: 'unknown', reason: 'missing-key' }));
    expect(read.pools.find(p => p.pool === 'codex-personal')?.pctUsed).toBeNull();
  });

  it('refuses a dangling symlink, regular file, or non-private directory mode on write', () => {
    const root = scratchRoot();
    const dangling = join(root, 'dangling-link');
    symlinkSync(join(root, 'does-not-exist'), dangling, dirLinkType());
    expect(() => writeResourceView(dangling, NOW)).toThrow();

    const filePath = join(root, 'not-a-dir');
    writeFileSync(filePath, 'x', { mode: 0o600 });
    expect(() => writeResourceView(filePath, NOW)).toThrow();

    if (process.platform !== 'win32') {
      const publicDir = join(root, 'public-dir');
      mkdirSync(publicDir, { mode: 0o755 });
      chmodSync(publicDir, 0o755);
      expect(() => writeResourceView(publicDir, NOW)).toThrow();
    }
  });
});

describe('phm resource CLI', () => {
  it('prints usage including --cards and $ASHLR_HOME on --help without creating storage', async () => {
    const root = scratchRoot();
    const unused = join(root, 'never-created');
    process.env['ASHLR_HOME'] = unused;
    const io = captureCliOutput();

    expect(await cmdResource(['--help'])).toBe(0);
    expect(io.stdout()).toContain('--cards');
    expect(io.stdout()).toContain('$ASHLR_HOME');
    expect(io.stderr()).toBe('');
    expect(existsSync(unused)).toBe(false);
  });

  it('prints provider-cards.v1 JSON under an ancestor-symlinked ASHLR_HOME with unknown readings', async () => {
    const root = scratchRoot();
    const realParent = join(root, 'real-parent');
    mkdirSync(realParent, { mode: 0o700 });
    const aliasParent = join(root, 'alias-parent');
    symlinkSync(realParent, aliasParent, dirLinkType());

    const scratchHome = join(realParent, 'scratch-ashlr');
    mkdirSync(scratchHome, { mode: 0o700 });
    process.env['ASHLR_HOME'] = join(aliasParent, 'scratch-ashlr');

    const io = captureCliOutput();
    expect(await cmdResource(['--cards', '--json'])).toBe(0);
    expect(io.stderr()).toBe('');
    const parsed = JSON.parse(io.stdout()) as {
      schema: string;
      providers: Array<{ provider: string; status: string; maxPctUsed: number | null }>;
      localModels: { count: number | null };
    };
    expect(parsed.schema).toBe('provider-cards.v1');
    expect(parsed.providers.map(p => p.provider)).toEqual(['openai', 'anthropic', 'cognition', 'xai']);
    expect(parsed.providers.every(p => p.status === 'unknown' && p.maxPctUsed === null)).toBe(true);
    expect(parsed.localModels.count).toBeNull();
    expect(existsSync(join(scratchHome, 'fleet.json'))).toBe(true);
  });

  it('prints resource.v1 JSON and plain-text summaries', async () => {
    const root = scratchRoot();
    const dir = join(root, 'fleet');
    mkdirSync(dir, { mode: 0o700 });

    const jsonIo = captureCliOutput();
    expect(await cmdResource(['--json', '--directory', dir])).toBe(0);
    expect(JSON.parse(jsonIo.stdout())).toMatchObject({ schema: 'resource.v1' });
    vi.restoreAllMocks();

    const textIo = captureCliOutput();
    expect(await cmdResource(['--cards', '--directory', dir])).toBe(0);
    expect(textIo.stdout()).toContain('OpenAI: unknown');
    expect(textIo.stdout()).toContain('Local models: unknown');
  });

  it('emits structured JSON errors on --json and actionable stderr without --json', async () => {
    const root = scratchRoot();
    const target = join(root, 'real');
    mkdirSync(target, { mode: 0o700 });
    const leafLink = join(root, 'bad-link');
    symlinkSync(target, leafLink, dirLinkType());

    // Usage error with --json
    let io = captureCliOutput();
    expect(await cmdResource(['--bogus', '--json'])).toBe(2);
    expect(io.stderr()).toBe('');
    expect(JSON.parse(io.stdout())).toEqual({
      ok: false,
      error: { code: 'usage', message: 'Invalid resource arguments. Use phm resource --help.' },
    });
    vi.restoreAllMocks();

    // Duplicate --directory rejected
    io = captureCliOutput();
    expect(await cmdResource(['--directory', target, '--directory', target, '--json'])).toBe(2);
    expect(JSON.parse(io.stdout())).toMatchObject({ ok: false, error: { code: 'usage' } });
    vi.restoreAllMocks();

    // Storage refusal with --json (never leaks raw path)
    io = captureCliOutput();
    expect(await cmdResource(['--cards', '--json', '--directory', leafLink])).toBe(1);
    expect(io.stderr()).toBe('');
    const errPayload = JSON.parse(io.stdout()) as { ok: boolean; error: { code: string; message: string } };
    expect(errPayload.ok).toBe(false);
    expect(errPayload.error.code).toBe('storage-unavailable');
    expect(errPayload.error.message).toContain('$ASHLR_HOME');
    expect(errPayload.error.message).not.toContain(leafLink);
    vi.restoreAllMocks();

    // Storage refusal without --json
    io = captureCliOutput();
    expect(await cmdResource(['--cards', '--directory', leafLink])).toBe(1);
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toContain('0700');
  });
});
