/**
 * core/settings-appearance.ts — the plain-word appearance settings an
 * operator or agent changes most: brand, theme, accent, density, font size.
 *
 * NOT a second store. These are a typed view over the ONE shared appearance
 * record (`<runs dir>/ui/appearance.json`, core/verse/ui-appearance-file.ts)
 * that the desktop app polls and applies live (web-ui/data/appearance-sync.ts)
 * and that `phm fleet appearance` already writes. The mapping:
 *
 *   theme     ↔ theme                     system | light | dark | high-contrast
 *   accent    ↔ accentH/accentS/accentL   '#rrggbb' (stored as integer HSL)
 *   density   ↔ density                   comfortable | compact
 *   fontSize  ↔ uiScale                   default | large | xlarge (or 100-125 %)
 *
 * Unlike the record's normalizer (which coerces silently, because a drag in
 * the UI must never fail), this module VALIDATES: an unknown key, a bad hex,
 * or a font size outside the three steps (or 100-125 %) is an error with a plain message,
 * so an agent learns what it did wrong instead of seeing a silent fallback.
 *
 * The accent is stored as integer hue/saturation/lightness, so a hex read back
 * can differ from the one written by one step in a channel; reading the value
 * back and setting it again is stable.
 */
import {
  defaultUiAppearance,
  UI_ACCENT_L_MAX,
  UI_ACCENT_L_MIN,
  UI_DENSITIES,
  UI_SCALES,
  UI_THEMES,
  type UiAppearance,
  type UiDensity,
  type UiScale,
  type UiTheme,
} from './verse/ui-appearance-file.js';
import { type BrandMark } from './brand/sidebar-upload.js';

export const APPEARANCE_SETTING_KEYS = ['theme', 'accent', 'density', 'fontSize', 'brand'] as const;
export type AppearanceSettingKey = (typeof APPEARANCE_SETTING_KEYS)[number];

export interface AppearanceSettings {
  brand: BrandMark;
  theme: UiTheme;
  /** Lowercase '#rrggbb'. */
  accent: string;
  density: UiDensity;
  /** Scales text (and spacing with it) across the app. */
  fontSize: UiScale;
}

/** The record fields one setting writes. */
export type AppearancePatch = Partial<Pick<UiAppearance, 'theme' | 'accentH' | 'accentS' | 'accentL' | 'density' | 'uiScale' | 'brand' | 'brandAsset'>>;

export type AppearanceValidation =
  | { ok: true; patch: AppearancePatch }
  | { ok: false; error: string };

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** Integer HSL (h 0-359, s/l 0-100) → '#rrggbb'. Same math as web-ui/design/contrast.ts accentHex. */
export function hslToHex(h: number, s: number, l: number): string {
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  const [r, g, b] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** '#rrggbb' or '#rgb' (the '#' optional) → integer HSL, or null when not a hex color. */
export function hexToHsl(input: string): { h: number; s: number; l: number } | null {
  const raw = input.trim().replace(/^#/, '');
  if (!/^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw)) return null;
  const full = raw.length === 3 ? raw.split('').map((ch) => ch + ch).join('') : raw;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h: ((Math.round(h) % 360) + 360) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** The settings as read from a stored (or default) appearance record. */
export function appearanceSettingsFrom(appearance: UiAppearance = defaultUiAppearance()): AppearanceSettings {
  return {
    brand: appearance.brand,
    theme: appearance.theme,
    accent: hslToHex(appearance.accentH, appearance.accentS, appearance.accentL),
    density: appearance.density,
    fontSize: appearance.uiScale,
  };
}

export function defaultAppearanceSettings(): AppearanceSettings {
  return appearanceSettingsFrom(defaultUiAppearance());
}

function oneOf(key: string, value: string, values: readonly string[]): string | null {
  return values.includes(value) ? null : `${key} must be one of: ${values.join(', ')} (got "${value}").`;
}

/** Validate one `key value` pair (both as typed on a command line) into a record patch. */
export function validateAppearanceSetting(key: string, value: string): AppearanceValidation {
  switch (key) {
    case 'brand':
      return value === 'p' || value === 'ghost'
        ? { ok: true, patch: { brand: value } }
        : { ok: false, error: 'brand must be p or ghost. To use an image, upload a brand file.' };
    case 'theme': {
      const error = oneOf(key, value, UI_THEMES);
      return error ? { ok: false, error } : { ok: true, patch: { theme: value as UiTheme } };
    }
    case 'density': {
      const error = oneOf(key, value, UI_DENSITIES);
      return error ? { ok: false, error } : { ok: true, patch: { density: value as UiDensity } };
    }
    case 'fontSize': {
      const uiScale = parseFontSize(value);
      return uiScale
        ? { ok: true, patch: { uiScale } }
        : { ok: false, error: `fontSize must be one of: ${UI_SCALES.join(', ')}, or a percent ${FONT_SIZE_MIN}-${FONT_SIZE_MAX} (got "${value}").` };
    }
    case 'accent': {
      const hsl = hexToHsl(value);
      if (!hsl) return { ok: false, error: `accent must be a hex color like #6366f1 (got "${value}").` };
      if (hsl.l < UI_ACCENT_L_MIN) return { ok: false, error: `accent ${value} is too dark to read; pick a color with lightness ${UI_ACCENT_L_MIN}-${UI_ACCENT_L_MAX}%.` };
      if (hsl.l > UI_ACCENT_L_MAX) return { ok: false, error: `accent ${value} is too light to read; pick a color with lightness ${UI_ACCENT_L_MIN}-${UI_ACCENT_L_MAX}%.` };
      return { ok: true, patch: { accentH: hsl.h, accentS: hsl.s, accentL: hsl.l } };
    }
    default:
      return { ok: false, error: `unknown setting "${key}"; use one of: ${APPEARANCE_SETTING_KEYS.join(', ')}.` };
  }
}

/** Validate a whole (partial) settings object; unknown keys and non-string values are rejected. */
export function validateAppearanceSettings(input: unknown): AppearanceValidation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'appearance settings must be an object.' };
  }
  let patch: AppearancePatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') {
      const known = (APPEARANCE_SETTING_KEYS as readonly string[]).includes(key);
      return { ok: false, error: known ? `${key} must be a string.` : `unknown setting "${key}"; use one of: ${APPEARANCE_SETTING_KEYS.join(', ')}.` };
    }
    const one = validateAppearanceSetting(key, value);
    if (!one.ok) return one;
    patch = { ...patch, ...one.patch };
  }
  return { ok: true, patch };
}

/**
 * What a theme preference paints. 'system' follows the OS: `osPrefersDark`
 * is the live OS answer, or null when it cannot be known (no probe on this
 * platform), in which case the result is 'unknown', never a guess.
 */
export function resolveAppearanceTheme(
  theme: UiTheme,
  osPrefersDark: boolean | null,
): 'light' | 'dark' | 'high-contrast' | 'unknown' {
  if (theme !== 'system') return theme;
  if (osPrefersDark === null) return 'unknown';
  return osPrefersDark ? 'dark' : 'light';
}

/**
 * Font size as a number: the percent of the default text size each step
 * paints (the --ui-text-scale of each [data-ui-scale] block in
 * web-ui/design/tokens.css). A number in range snaps to the nearest step.
 */
export const FONT_SIZE_PERCENT: Readonly<Record<UiScale, number>> = { default: 100, large: 112.5, xlarge: 125 };
const FONT_SIZE_MIN = 100;
const FONT_SIZE_MAX = 125;

/** `default|large|xlarge`, or a percent 100-125 snapped to the nearest step; null when neither. */
export function parseFontSize(value: string): UiScale | null {
  if ((UI_SCALES as readonly string[]).includes(value)) return value as UiScale;
  const raw = value.trim().replace(/%$/, '');
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  if (n < FONT_SIZE_MIN || n > FONT_SIZE_MAX) return null;
  let best: UiScale = 'default';
  for (const scale of UI_SCALES) {
    if (Math.abs(FONT_SIZE_PERCENT[scale] - n) < Math.abs(FONT_SIZE_PERCENT[best] - n)) best = scale;
  }
  return best;
}

/**
 * The lenient read: any input (a stored blob, a hand-edited file, null)
 * becomes valid settings. Each value that does not validate falls back
 * to ITS default; this never throws. Writes use the strict validators above.
 */
export function normalizeAppearanceSettings(input: unknown): AppearanceSettings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return defaultAppearanceSettings();
  const record = input as Record<string, unknown>;
  let patch: AppearancePatch = {};
  for (const key of APPEARANCE_SETTING_KEYS) {
    const value = record[key];
    const checked = typeof value === 'string' ? validateAppearanceSetting(key, value) : null;
    if (checked?.ok) patch = { ...patch, ...checked.patch };
  }
  if (record.brand === 'upload') patch.brand = 'upload';
  return appearanceSettingsFrom({ ...defaultUiAppearance(), ...patch });
}

/** CLI flag → setting key, for `phm settings appearance --theme dark …`. */
export const APPEARANCE_FLAGS: Readonly<Record<string, AppearanceSettingKey>> = {
  '--theme': 'theme',
  '--accent': 'accent',
  '--density': 'density',
  '--font-size': 'fontSize',
  '--brand': 'brand',
};

/**
 * Parse `--theme <v> --accent <v> --density <v> --font-size <v>` (also the
 * `--flag=value` form) into ONE validated record patch, so several settings
 * land in a single write. `settings` lists the keys given, in order.
 */
export function parseAppearanceFlags(
  args: readonly string[],
): { ok: true; patch: AppearancePatch; settings: AppearanceSettingKey[]; brandFile?: string } | { ok: false; error: string } {
  let patch: AppearancePatch = {};
  const settings: AppearanceSettingKey[] = [];
  let brandFile: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
    const key = APPEARANCE_FLAGS[flag];
    if (key === undefined && flag !== '--brand-file') return { ok: false, error: `unknown option "${arg}"; use ${[...Object.keys(APPEARANCE_FLAGS), '--brand-file'].join(', ')}.` };
    if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) return { ok: false, error: `${flag} needs a value.` };
    if (key === undefined) {
      if (brandFile !== undefined) return { ok: false, error: '--brand-file was given twice.' };
      brandFile = value;
      continue;
    }
    if (settings.includes(key)) return { ok: false, error: `${flag} was given twice.` };
    const checked = validateAppearanceSetting(key, value);
    if (!checked.ok) return checked;
    patch = { ...patch, ...checked.patch };
    settings.push(key);
  }
  if (brandFile !== undefined && patch.brand !== undefined) return { ok: false, error: 'Use --brand or --brand-file, not both.' };
  return { ok: true, patch, settings, ...(brandFile === undefined ? {} : { brandFile }) };
}
