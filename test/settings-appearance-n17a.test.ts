/**
 * settings-appearance-n17a — `phm settings appearance [get]|set` and the typed
 * four-key module behind it (core/settings-appearance.ts): defaults,
 * validation errors, a set followed by a get against the SAME shared record
 * the app polls, and system theme resolution. Hermetic: ASHLR_RUNS_DIR points
 * at a temp dir and the OS theme probe is injected.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdSettings, SETTINGS_APPEARANCE_SCHEMA } from '../src/cli/settings-appearance.js';
import {
  appearanceSettingsFrom,
  defaultAppearanceSettings,
  hexToHsl,
  hslToHex,
  resolveAppearanceTheme,
  validateAppearanceSetting,
  validateAppearanceSettings,
} from '../src/core/settings-appearance.js';
import { readUiAppearanceFile, uiAppearancePath } from '../src/core/verse/ui-appearance-file.js';

let dir: string;
let savedRunsDir: string | undefined;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-appearance-n17a-'));
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

const osDark = (value: boolean | null) => ({ osPrefersDark: async () => value });
const lastJson = (): Record<string, any> => JSON.parse(out.at(-1)!);

describe('defaults', () => {
  it('match the app defaults (system theme, indigo accent, comfortable, default size)', () => {
    expect(defaultAppearanceSettings()).toEqual({ theme: 'system', accent: '#5447e1', density: 'comfortable', fontSize: 'default' });
  });

  it('get --json with nothing saved reports defaults, saved:false, revision 0', async () => {
    expect(await cmdSettings(['appearance', 'get', '--json'], osDark(false))).toBe(0);
    const v = lastJson();
    expect(v.schema).toBe(SETTINGS_APPEARANCE_SCHEMA);
    expect(v.ok).toBe(true);
    expect(v.appearance).toEqual(defaultAppearanceSettings());
    expect(v.saved).toBe(false);
    expect(v.revision).toBe(0);
    expect(v.updatedBy).toBeNull();
  });
  it('bare `appearance --json` reads (the documented form), same payload as `get`', async () => {
    expect(await cmdSettings(['appearance', '--json'], osDark(true))).toBe(0);
    const bare = lastJson();
    expect(await cmdSettings(['appearance', 'get', '--json'], osDark(true))).toBe(0);
    expect(bare).toEqual(lastJson());
    expect(bare.resolvedTheme).toBe('dark');
    expect(await cmdSettings(['appearance'], osDark(false))).toBe(0);
    expect(out.at(-1)).toMatch(/^theme {5}system \(light right now\)/);
  });
});

describe('validation', () => {
  it('rejects unknown keys, bad enum values, non-hex and unreadable accents', () => {
    expect(validateAppearanceSetting('colour', 'red')).toEqual({ ok: false, error: expect.stringContaining('unknown setting "colour"') });
    expect(validateAppearanceSetting('theme', 'sepia')).toEqual({ ok: false, error: expect.stringContaining('theme must be one of') });
    expect(validateAppearanceSetting('density', 'cozy').ok).toBe(false);
    expect(validateAppearanceSetting('fontSize', '18').ok).toBe(false);
    expect(validateAppearanceSetting('fontSize', 'huge').ok).toBe(false);
    expect(validateAppearanceSetting('accent', 'blue')).toEqual({ ok: false, error: expect.stringContaining('hex color') });
    expect(validateAppearanceSetting('accent', '#12345')).toEqual({ ok: false, error: expect.stringContaining('hex color') });
    expect(validateAppearanceSetting('accent', '#000000')).toEqual({ ok: false, error: expect.stringContaining('too dark') });
    expect(validateAppearanceSetting('accent', '#ffffff')).toEqual({ ok: false, error: expect.stringContaining('too light') });
  });

  it('accepts #rgb and #rrggbb (with or without #) and maps fontSize onto uiScale', () => {
    expect(validateAppearanceSetting('accent', '#e11d48')).toEqual({ ok: true, patch: { accentH: 347, accentS: 77, accentL: 50 } });
    expect(validateAppearanceSetting('accent', '0af').ok).toBe(true);
    expect(validateAppearanceSetting('fontSize', 'xlarge')).toEqual({ ok: true, patch: { uiScale: 'xlarge' } });
  });

  it('object validation rejects unknown keys and non-string values', () => {
    expect(validateAppearanceSettings({ theme: 'dark', radius: 'soft' })).toEqual({ ok: false, error: expect.stringContaining('unknown setting "radius"') });
    expect(validateAppearanceSettings({ theme: 1 })).toEqual({ ok: false, error: 'theme must be a string.' });
    expect(validateAppearanceSettings([])).toEqual({ ok: false, error: 'appearance settings must be an object.' });
    expect(validateAppearanceSettings({ theme: 'light', density: 'compact' })).toEqual({ ok: true, patch: { theme: 'light', density: 'compact' } });
  });

  it('CLI exits 2 on an invalid value and writes nothing; --json prints { ok:false, error }', async () => {
    expect(await cmdSettings(['appearance', 'set', 'accent', 'not-a-color', '--json'])).toBe(2);
    expect(lastJson()).toEqual({ schema: SETTINGS_APPEARANCE_SCHEMA, ok: false, error: expect.stringContaining('hex color') });
    expect(await cmdSettings(['appearance', 'set', 'radius', 'soft'])).toBe(2);
    expect(err.join('\n')).toContain('unknown setting "radius"');
    expect(await readUiAppearanceFile()).toBeNull();
  });

  it('CLI exits 2 on bad usage', async () => {
    expect(await cmdSettings([])).toBe(2);
    expect(await cmdSettings(['display', 'get'])).toBe(2);
    expect(await cmdSettings(['appearance', 'set', 'theme'])).toBe(2);
    expect(await cmdSettings(['appearance', 'set', 'theme', 'dark', 'extra'])).toBe(2);
    expect(await cmdSettings(['appearance', 'get', 'theme'])).toBe(2);
    expect(await cmdSettings(['appearance', 'theme'])).toBe(2);
    expect(await cmdSettings(['--help'])).toBe(0);
  });
});

describe('set then get', () => {
  it('round-trips every key through the shared appearance record the app polls', async () => {
    expect(await cmdSettings(['appearance', 'set', 'theme', 'dark', '--json'], osDark(null))).toBe(0);
    expect(await cmdSettings(['appearance', 'set', 'density', 'compact', '--json'], osDark(null))).toBe(0);
    expect(await cmdSettings(['appearance', 'set', 'fontSize', 'large', '--json'], osDark(null))).toBe(0);
    expect(await cmdSettings(['appearance', 'set', 'accent', '#E11D48', '--json'], osDark(null))).toBe(0);
    const set = lastJson();
    expect(set.revision).toBe(4);

    expect(await cmdSettings(['appearance', 'get', '--json'], osDark(null))).toBe(0);
    const got = lastJson();
    expect(got.appearance).toEqual({ theme: 'dark', accent: set.appearance.accent, density: 'compact', fontSize: 'large' });
    expect(got.resolvedTheme).toBe('dark');
    expect(got.saved).toBe(true);
    expect(got.updatedBy).toBe('cli');
    // Integer HSL storage: within one step of what was written, and stable when re-set.
    expect(Math.abs(parseInt(got.appearance.accent.slice(1, 3), 16) - 0xe1)).toBeLessThanOrEqual(2);
    expect(await cmdSettings(['appearance', 'set', 'accent', got.appearance.accent, '--json'], osDark(null))).toBe(0);
    expect(lastJson().appearance.accent).toBe(got.appearance.accent);

    // The app reads this exact file; its other fields are left untouched.
    const onDisk = JSON.parse(readFileSync(uiAppearancePath(), 'utf8'));
    expect(onDisk.appearance).toMatchObject({ theme: 'dark', density: 'compact', uiScale: 'large', radius: 'default', layout: 'auto' });
  });

  it('human output names each key in plain words', async () => {
    await cmdSettings(['appearance', 'set', 'theme', 'light']);
    expect(out.at(-1)).toMatch(/^theme {5}light\naccent {4}#[0-9a-f]{6}\ndensity {3}comfortable\nfontSize {2}default\nsaved by cli/);
  });
});

describe('system theme resolution', () => {
  it('system follows the OS answer; unknown when the OS cannot be asked; explicit themes answer themselves', () => {
    expect(resolveAppearanceTheme('system', true)).toBe('dark');
    expect(resolveAppearanceTheme('system', false)).toBe('light');
    expect(resolveAppearanceTheme('system', null)).toBe('unknown');
    expect(resolveAppearanceTheme('light', true)).toBe('light');
    expect(resolveAppearanceTheme('dark', false)).toBe('dark');
    expect(resolveAppearanceTheme('high-contrast', null)).toBe('high-contrast');
  });

  it('get reports what system paints right now, re-asking the OS each time', async () => {
    await cmdSettings(['appearance', 'get', '--json'], osDark(true));
    expect(lastJson().resolvedTheme).toBe('dark');
    await cmdSettings(['appearance', 'get', '--json'], osDark(false));
    expect(lastJson().resolvedTheme).toBe('light');
    await cmdSettings(['appearance', 'get', '--json'], osDark(null));
    expect(lastJson().resolvedTheme).toBe('unknown');
  });
});

describe('hex conversion', () => {
  it('hslToHex and hexToHsl agree on the accent presets', () => {
    for (const [h, s, l] of [[245, 72, 58], [212, 80, 50], [168, 70, 38], [348, 72, 50]] as const) {
      const back = hexToHsl(hslToHex(h, s, l))!;
      expect(Math.abs(back.h - h)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.s - s)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.l - l)).toBeLessThanOrEqual(1);
    }
    expect(appearanceSettingsFrom().accent).toBe(hslToHex(245, 72, 58));
  });
});
