/**
 * settings-appearance — Settings ▸ Appearance as agents drive it:
 * `phm settings appearance [--theme] [--accent] [--density] [--font-size]
 * [--reset] [--json]` and `GET|PATCH /api/verse/appearance/settings`, both over
 * the one shared record the desktop and phone app poll and apply live.
 *
 * Covers defaults, a round-trip per setting (CLI and API), invalid values
 * (strict on write, lenient on read: never a crash), "system" following the
 * OS as it switches, and the CLI --json shape. Runs under a temp runs dir.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdSettings, SETTINGS_APPEARANCE_SCHEMA } from '../src/cli/settings-appearance.js';
import {
  defaultAppearanceSettings,
  normalizeAppearanceSettings,
  parseAppearanceFlags,
  parseFontSize,
  resolveAppearanceTheme,
} from '../src/core/settings-appearance.js';
import { handleAppearanceSettings, VERSE_APPEARANCE_SETTINGS_PATH } from '../src/core/verse/ui-appearance-api.js';
import { handleVerseApi, type VerseApiContext } from '../src/core/verse/verse-api.js';
import { readUiAppearanceFile, uiAppearancePath } from '../src/core/verse/ui-appearance-file.js';
import type { AshlrConfig } from '../src/core/types.js';

const AUTH = 'plain-words';
let dir = '';
let savedRunsDir: string | undefined;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-appearance-'));
  savedRunsDir = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = dir;
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedRunsDir === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = savedRunsDir;
  rmSync(dir, { recursive: true, force: true });
});

const os = (value: boolean | null) => ({ osPrefersDark: async () => value });
const lastJson = (): Record<string, any> => JSON.parse(out.at(-1)!);
const DEFAULTS = { theme: 'system', accent: '#5447e1', density: 'comfortable', fontSize: 'default', brand: 'p' };

describe('defaults', () => {
  it('are safe and match the app (system, indigo, comfortable, default size)', () => {
    expect(defaultAppearanceSettings()).toEqual(DEFAULTS);
  });

  it('nothing saved reads as the defaults, saved:false', async () => {
    expect(await cmdSettings(['appearance', '--json'], os(false))).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, appearance: DEFAULTS, saved: false, revision: 0 });
  });
});

describe('CLI --json shape', () => {
  it('has exactly the documented keys and types', async () => {
    expect(await cmdSettings(['appearance', '--theme', 'dark', '--json'], os(null))).toBe(0);
    const v = lastJson();
    expect(Object.keys(v).sort()).toEqual(['appearance', 'ok', 'resolvedTheme', 'revision', 'saved', 'schema', 'updatedAt', 'updatedBy']);
    expect(Object.keys(v.appearance).sort()).toEqual(['accent', 'brand', 'density', 'fontSize', 'theme']);
    expect(v.schema).toBe(SETTINGS_APPEARANCE_SCHEMA);
    expect(typeof v.revision).toBe('number');
    expect(typeof v.updatedAt).toBe('string');
    expect(v.updatedBy).toBe('cli');
    expect(v.saved).toBe(true);
  });

  it('an error is { schema, ok:false, error } on stdout with exit 2', async () => {
    expect(await cmdSettings(['appearance', '--theme', 'purple', '--json'], os(null))).toBe(2);
    const v = lastJson();
    expect(Object.keys(v).sort()).toEqual(['error', 'ok', 'schema']);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/theme must be one of: system, light, dark, high-contrast/);
  });
});

describe('each setting round-trips through the CLI flags', () => {
  const cases: Array<[string, string, string, string]> = [
    ['--theme', 'light', 'theme', 'light'],
    ['--theme', 'dark', 'theme', 'dark'],
    ['--theme', 'high-contrast', 'theme', 'high-contrast'],
    ['--accent', '#0d9488', 'accent', '#0d968b'],
    ['--density', 'compact', 'density', 'compact'],
    ['--font-size', 'large', 'fontSize', 'large'],
    ['--font-size', '125', 'fontSize', 'xlarge'],
    ['--font-size', '110%', 'fontSize', 'large'],
    ['--font-size', '100', 'fontSize', 'default'],
  ];
  it.each(cases)('%s %s → %s %s, and reads back the same', async (flag, value, key, expected) => {
    expect(await cmdSettings(['appearance', flag, value, '--json'], os(false))).toBe(0);
    expect(lastJson().appearance[key]).toBe(expected);
    expect(await cmdSettings(['appearance', '--json'], os(false))).toBe(0);
    expect(lastJson().appearance[key]).toBe(expected);
  });

  it('an accent read back and set again is stable', async () => {
    await cmdSettings(['appearance', '--accent', '#0d9488', '--json'], os(false));
    const first = lastJson().appearance.accent as string;
    await cmdSettings(['appearance', `--accent=${first}`, '--json'], os(false));
    expect(lastJson().appearance.accent).toBe(first);
  });

  it('several flags land in ONE write (one revision)', async () => {
    expect(await cmdSettings(['appearance', '--theme', 'dark', '--density=compact', '--font-size', 'xlarge', '--json'], os(false))).toBe(0);
    expect(lastJson()).toMatchObject({ revision: 1, appearance: { theme: 'dark', density: 'compact', fontSize: 'xlarge' } });
  });

  it('--reset restores every default, like the page button', async () => {
    await cmdSettings(['appearance', '--theme', 'dark', '--accent', '#e11d48', '--density', 'compact', '--json'], os(false));
    expect(await cmdSettings(['appearance', '--reset', '--json'], os(false))).toBe(0);
    expect(lastJson().appearance).toEqual(DEFAULTS);
    expect((await readUiAppearanceFile())?.appearance.radius).toBe('default');
  });

  it('the older `set <key> <value>` form still works', async () => {
    expect(await cmdSettings(['appearance', 'set', 'density', 'compact', '--json'], os(false))).toBe(0);
    expect(lastJson().appearance.density).toBe('compact');
  });
});

describe('invalid values', () => {
  it.each([
    [['--theme', 'sepia'], /theme must be one of/],
    [['--accent', 'blue'], /accent must be a hex color/],
    [['--accent', '#000000'], /too dark to read/],
    [['--accent', '#ffffff'], /too light to read/],
    [['--density', 'roomy'], /density must be one of/],
    [['--font-size', '90'], /fontSize must be one of: default, large, xlarge, or a percent 100-125/],
    [['--font-size', 'huge'], /fontSize must be one of/],
    [['--theme'], /--theme needs a value/],
    [['--theme', '--density', 'compact'], /--theme needs a value/],
    [['--theme', 'dark', '--theme', 'light'], /given twice/],
    [['--colour', 'red'], /unknown option "--colour"/],
    [['--reset', '--theme', 'dark'], /--reset takes no other settings/],
  ])('%j is refused with a plain message and nothing is written', async (flags, message) => {
    expect(await cmdSettings(['appearance', ...flags], os(false))).toBe(2);
    expect(err.join('\n')).toMatch(message);
    expect(await readUiAppearanceFile()).toBeNull();
  });

  it('the lenient read never throws: each bad value falls back to its own default', () => {
    expect(normalizeAppearanceSettings(null)).toEqual(DEFAULTS);
    expect(normalizeAppearanceSettings('dark')).toEqual(DEFAULTS);
    expect(normalizeAppearanceSettings([1, 2])).toEqual(DEFAULTS);
    expect(normalizeAppearanceSettings({ theme: 'sepia', accent: 7, density: 'compact', fontSize: '999', extra: true }))
      .toEqual({ ...DEFAULTS, density: 'compact' });
  });

  it('a corrupt stored record reads as the defaults (no crash)', async () => {
    mkdirSync(join(uiAppearancePath(), '..'), { recursive: true });
    writeFileSync(uiAppearancePath(), '{ not json');
    expect(await cmdSettings(['appearance', '--json'], os(false))).toBe(0);
    expect(lastJson()).toMatchObject({ appearance: DEFAULTS, saved: false });
  });

  it('parse helpers reject without throwing', () => {
    expect(parseFontSize('')).toBeNull();
    expect(parseFontSize('-5')).toBeNull();
    expect(parseFontSize('126')).toBeNull();
    expect(parseAppearanceFlags(['--accent', '#12'])).toMatchObject({ ok: false });
  });
});

describe('system theme follows the OS and switches live', () => {
  it('resolves per the OS answer, and unknown stays unknown', () => {
    expect(resolveAppearanceTheme('system', true)).toBe('dark');
    expect(resolveAppearanceTheme('system', false)).toBe('light');
    expect(resolveAppearanceTheme('system', null)).toBe('unknown');
    expect(resolveAppearanceTheme('light', true)).toBe('light');
    expect(resolveAppearanceTheme('dark', false)).toBe('dark');
  });

  it('the same saved "system" reads dark, then light, as the OS flips; no write in between', async () => {
    let osDark = true;
    const deps = { osPrefersDark: async () => osDark };
    await cmdSettings(['appearance', '--theme', 'system', '--json'], deps);
    expect(lastJson()).toMatchObject({ resolvedTheme: 'dark', revision: 1 });
    osDark = false;
    await cmdSettings(['appearance', '--json'], deps);
    expect(lastJson()).toMatchObject({ resolvedTheme: 'light', revision: 1, appearance: { theme: 'system' } });
    osDark = true;
    await cmdSettings(['appearance', '--json'], deps);
    expect(lastJson().resolvedTheme).toBe('dark');
  });

  it('a fixed theme does not ask the OS at all', async () => {
    const probe = vi.fn(async () => true);
    await cmdSettings(['appearance', '--theme', 'light', '--json'], { osPrefersDark: probe });
    expect(lastJson().resolvedTheme).toBe('light');
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('GET|PATCH /api/verse/appearance/settings', () => {
  const ctx = (allowDispatch = true): VerseApiContext => ({ cfg: {} as AshlrConfig, token: AUTH, allowDispatch });

  async function call(method: string, body?: unknown, opts: { auth?: string; dispatch?: boolean; url?: string; viaRouter?: boolean } = {}) {
    const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const url = opts.url ?? VERSE_APPEARANCE_SETTINGS_PATH;
    const req = Object.assign(Readable.from(raw ? [raw] : []), {
      method, url, headers: { 'x-ashlr-token': opts.auth ?? AUTH, 'content-type': 'application/json' },
    }) as unknown as IncomingMessage;
    const reply = { status: 0, body: {} as Record<string, any> };
    const res = {
      headersSent: false,
      writeHead(code: number) { reply.status = code; return res; },
      setHeader() { return res; },
      end(chunk?: Buffer | string) { if (chunk) reply.body = JSON.parse(String(chunk)); return res; },
    } as unknown as ServerResponse;
    const c = ctx(opts.dispatch ?? true);
    if (opts.viaRouter) await handleVerseApi(c, req, res, url.split('?')[0]!, method);
    else await handleAppearanceSettings(c, req, res, method);
    return reply;
  }

  it('reads the defaults, then each PATCH round-trips and is what the CLI reads', async () => {
    expect(await call('GET')).toEqual({ status: 200, body: { appearance: DEFAULTS, saved: false, revision: 0 } });
    const patched = await call('PATCH', { theme: 'dark', accent: '#e11d48', density: 'compact', fontSize: '125' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ saved: true, revision: 1, appearance: { theme: 'dark', density: 'compact', fontSize: 'xlarge' } });
    await cmdSettings(['appearance', '--json'], os(false));
    expect(lastJson().appearance).toEqual(patched.body.appearance);
    expect((await readUiAppearanceFile())?.updatedBy).toBe('api');
  });

  it('is mounted on the verse router', async () => {
    expect((await call('GET', undefined, { viaRouter: true })).body).toMatchObject({ appearance: DEFAULTS });
  });

  it('refuses bad input with 400 and writes nothing', async () => {
    expect((await call('PATCH', { theme: 'sepia' })).status).toBe(400);
    expect((await call('PATCH', { colour: 'red' })).body.error).toMatch(/unknown setting "colour"/);
    expect((await call('PATCH', '{ nope')).status).toBe(400);
    expect((await call('PATCH', [1])).status).toBe(400);
    expect((await call('GET', undefined, { url: `${VERSE_APPEARANCE_SETTINGS_PATH}?x=1` })).status).toBe(400);
    expect(await readUiAppearanceFile()).toBeNull();
  });

  it('writes are gated like the full appearance PUT', async () => {
    expect((await call('PATCH', { theme: 'dark' }, { dispatch: false })).status).toBe(404);
    expect((await call('PATCH', { theme: 'dark' }, { auth: 'wrong' })).status).toBe(401);
    expect((await call('DELETE')).status).toBe(405);
    expect(await readUiAppearanceFile()).toBeNull();
  });
});
