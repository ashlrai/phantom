/**
 * ui-appearance-file-119 — the shared appearance record
 * (<runs>/ui/appearance.json): normalize parity with the web appearance store,
 * corrupt → null, atomic 0600 write into a 0700 dir, revision CAS.
 *
 * The enum parity check cannot import the web store (it touches document at
 * evaluation time), so it compares TYPE-LEVEL at compile time and reads the
 * web sources as text at run time: if either side's union drifts, this fails.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Appearance } from '../src/web-ui/data/appearance-store.js';
import {
  UI_ACCENT_L_MAX,
  UI_ACCENT_L_MIN,
  UI_DEFAULT_ACCENT,
  UI_DENSITIES,
  UI_DISPLAY_FONTS,
  UI_LAYOUTS,
  UI_MOTIONS,
  UI_RADII,
  UI_SCALES,
  UI_THEMES,
  defaultUiAppearance,
  normalizeUiAppearance,
  readUiAppearanceFile,
  uiAppearancePath,
  updateUiAppearanceFile,
  type UiDensity,
  type UiDisplayFont,
  type UiLayout,
  type UiMotion,
  type UiRadius,
  type UiScale,
  type UiTheme,
} from '../src/core/verse/ui-appearance-file.js';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
// Compile-time parity: each core union must be exactly the web field's union.
const _parity: [
  Exact<UiTheme, Appearance['theme']>,
  Exact<UiDensity, Appearance['density']>,
  Exact<UiScale, Appearance['uiScale']>,
  Exact<UiDisplayFont, Appearance['displayFont']>,
  Exact<UiRadius, Appearance['radius']>,
  Exact<UiLayout, Appearance['layout']>,
  Exact<UiMotion, Appearance['motion']>,
] = [true, true, true, true, true, true, true];
void _parity;

const STORE = 'src/web-ui/data/appearance-store.ts';

function unionMembers(file: string, typeName: string): string[] {
  const src = readFileSync(join(process.cwd(), file), 'utf8');
  const decl = new RegExp(`export type ${typeName} = ([^;]+);`).exec(src);
  if (!decl) throw new Error(`${typeName} not found in ${file}`);
  return [...decl[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

let runs = '';
let saved: string | undefined;

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'ui-appearance-119-'));
  saved = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = runs;
});
afterEach(() => {
  if (saved === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = saved;
  rmSync(runs, { recursive: true, force: true });
});

describe('enum and constant parity with the web appearance store', () => {
  it('matches every union member set, the accent band and the default accent', () => {
    expect([...UI_THEMES]).toEqual(unionMembers('src/web-ui/data/theme-store.ts', 'ThemePreference'));
    expect([...UI_DENSITIES]).toEqual(unionMembers(STORE, 'Density'));
    expect([...UI_SCALES]).toEqual(unionMembers(STORE, 'UiScale'));
    expect([...UI_DISPLAY_FONTS]).toEqual(unionMembers(STORE, 'DisplayFont'));
    expect([...UI_RADII]).toEqual(unionMembers(STORE, 'RadiusScale'));
    expect([...UI_LAYOUTS]).toEqual(unionMembers('src/web-ui/routes/verse/layout-mode.ts', 'LayoutPreference'));
    expect([...UI_MOTIONS]).toEqual(unionMembers(STORE, 'MotionPreference'));
    const store = readFileSync(join(process.cwd(), STORE), 'utf8');
    expect(store).toContain(`ACCENT_L_MIN = ${UI_ACCENT_L_MIN}`);
    expect(store).toContain(`ACCENT_L_MAX = ${UI_ACCENT_L_MAX}`);
    const accent = /DEFAULT_ACCENT = \{ h: (\d+), s: (\d+), l: (\d+) \}/.exec(store);
    expect(accent).not.toBeNull();
    expect([Number(accent![1]), Number(accent![2]), Number(accent![3])])
      .toEqual([UI_DEFAULT_ACCENT.h, UI_DEFAULT_ACCENT.s, UI_DEFAULT_ACCENT.l]);
  });
});

describe('normalizeUiAppearance', () => {
  it('clamps and wraps exactly like the web normalize', () => {
    const base = defaultUiAppearance();
    expect(normalizeUiAppearance(base, {
      accentH: 370, accentS: 250, accentL: 99,
      density: 'compact', uiScale: 'large', displayFont: 'mono', radius: 'soft', layout: 'wide', motion: 'reduce', theme: 'dark',
    })).toEqual({
      theme: 'dark', accentH: 10, accentS: 100, accentL: UI_ACCENT_L_MAX,
      density: 'compact', uiScale: 'large', displayFont: 'mono', radius: 'soft', layout: 'wide', motion: 'reduce',
    });
    expect(normalizeUiAppearance(base, { accentH: -10, accentS: -5, accentL: 10 }))
      .toMatchObject({ accentH: 350, accentS: 0, accentL: UI_ACCENT_L_MIN });
  });

  it('falls back to each field\'s constant default, never the base value', () => {
    const base = { ...defaultUiAppearance(), theme: 'dark' as const, density: 'compact' as const, accentH: 10 };
    expect(normalizeUiAppearance(base, { theme: 'neon', density: 'spacious', accentH: 'x' }))
      .toMatchObject({ theme: 'system', density: 'comfortable', accentH: UI_DEFAULT_ACCENT.h });
    // A valid patch value still merges over the base.
    expect(normalizeUiAppearance(base, { motion: 'full' })).toMatchObject({ theme: 'dark', accentH: 10, motion: 'full' });
  });

  it('maps a bare reduceMotion boolean like the web Settings switch does', () => {
    const base = defaultUiAppearance();
    expect(normalizeUiAppearance(base, { reduceMotion: true }).motion).toBe('reduce');
    expect(normalizeUiAppearance(base, { reduceMotion: false }).motion).toBe('full');
    // An explicit motion wins over the boolean.
    expect(normalizeUiAppearance(base, { motion: 'system', reduceMotion: true }).motion).toBe('system');
  });
});

describe('readUiAppearanceFile / updateUiAppearanceFile', () => {
  it('reads a missing, corrupt or wrong-shaped file as null, never a throw', async () => {
    expect(await readUiAppearanceFile()).toBeNull();
    mkdirSync(dirname(uiAppearancePath()), { recursive: true });
    writeFileSync(uiAppearancePath(), 'not json at all', { mode: 0o600 });
    expect(await readUiAppearanceFile()).toBeNull();
    for (const bad of [{}, [], { version: 2, revision: 1, appearance: {} }, { version: 1, revision: 'x', appearance: {} }, { version: 1, revision: -1, appearance: {} }, { version: 1, revision: 1 }]) {
      writeFileSync(uiAppearancePath(), JSON.stringify(bad));
      expect(await readUiAppearanceFile(), JSON.stringify(bad)).toBeNull();
    }
  });

  it('writes revision+1 atomically into a 0700 dir as a 0600 file', async () => {
    const dir = dirname(uiAppearancePath());
    const first = await updateUiAppearanceFile({ theme: 'dark', accentL: 99 }, { updatedBy: 'test' });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error('unreachable');
    expect(first.file.revision).toBe(1);
    expect(first.file.updatedBy).toBe('test');
    expect(first.file.appearance).toMatchObject({ theme: 'dark', accentL: UI_ACCENT_L_MAX });
    expect(statSync(uiAppearancePath()).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // The stored record reads back with normalized values and no tmp litter.
    expect((await readUiAppearanceFile())?.appearance.theme).toBe('dark');
  });

  it('honours expectedRevision as a compare-and-swap', async () => {
    const first = await updateUiAppearanceFile({ theme: 'dark' }, { updatedBy: 'a' });
    expect(first.ok).toBe(true);
    const stale = await updateUiAppearanceFile({ theme: 'light' }, { expectedRevision: 0, updatedBy: 'b' });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('unreachable');
    expect(stale.conflict?.revision).toBe(1);
    const second = await updateUiAppearanceFile({ theme: 'light' }, { expectedRevision: 1, updatedBy: 'b' });
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) throw new Error('unreachable');
    expect(second.file.revision).toBe(2);
    expect(second.file.appearance.theme).toBe('light');
    expect((await readUiAppearanceFile())?.revision).toBe(2);
  });
});
