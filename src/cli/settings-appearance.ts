/**
 * `phm settings appearance` — the desktop and phone app's theme, accent,
 * density and font size, as a typed CLI so agents can read and change them.
 *
 *   phm settings appearance [--json]          (read; `get` is an alias)
 *   phm settings appearance [--theme <t>] [--accent <hex>] [--density <d>] [--font-size <n>] [--json]
 *   phm settings appearance --reset [--json]  (the page's "Reset to defaults")
 *   phm settings appearance set <key> <value> [--json]   (one key, older form)
 *
 * Several flags land in ONE write, so the app never paints a half-applied mix.
 *
 * Reads and writes the SAME shared record the app polls and applies live
 * (<runs dir>/ui/appearance.json via core/verse/ui-appearance-file.ts); the
 * four keys and their validation live in core/settings-appearance.ts. The
 * fuller set (radius, layout, motion, display font, raw accent channels)
 * stays on `phm fleet appearance`.
 *
 * Exit codes: 0 ok, 1 the record changed mid-write (retry), 2 bad usage or an
 * invalid value. With --json, errors print `{ ok: false, error }` on stdout.
 */
import { execFile } from 'node:child_process';
import {
  APPEARANCE_SETTING_KEYS,
  appearanceSettingsFrom,
  parseAppearanceFlags,
  resolveAppearanceTheme,
  validateAppearanceSetting,
  type AppearanceSettings,
} from '../core/settings-appearance.js';
import {
  defaultUiAppearance,
  readUiAppearanceFile,
  updateUiAppearanceFile,
  UI_DENSITIES,
  UI_SCALES,
  UI_THEMES,
  type UiAppearanceFile,
} from '../core/verse/ui-appearance-file.js';

export const SETTINGS_APPEARANCE_SCHEMA = 'phm.settings.appearance.v1';

const USAGE = `Usage: phm settings appearance [--json]
       phm settings appearance [--theme <t>] [--accent <hex>] [--density <d>] [--font-size <n>] [--json]
       phm settings appearance --reset [--json]
       phm settings appearance set <key> <value> [--json]

Settings:
  --theme      ${UI_THEMES.join(' | ')}
  --accent     a hex color, e.g. #6366f1
  --density    ${UI_DENSITIES.join(' | ')}
  --font-size  ${UI_SCALES.join(' | ')}, or a percent 100-125
  --reset      back to the defaults, like the page's "Reset to defaults"

A running Phantom app applies a change within a few seconds, no restart.
More options (radius, layout, motion): phm fleet appearance --help.`;

export interface SettingsAppearanceDeps {
  /** Does the OS prefer dark right now? null = cannot tell. Injected by tests. */
  osPrefersDark?: () => Promise<boolean | null>;
}

/**
 * macOS: `defaults read -g AppleInterfaceStyle` prints "Dark" in dark mode
 * and fails (the key is absent) in light mode. Elsewhere: unknown.
 */
function macPrefersDark(): Promise<boolean | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('defaults', ['read', '-g', 'AppleInterfaceStyle'], { timeout: 2_000 }, (error, stdout) => {
      if (!error) resolve(stdout.trim() === 'Dark');
      else resolve(typeof error.code === 'number' ? false : null);
    });
  });
}

interface AppearanceView {
  schema: typeof SETTINGS_APPEARANCE_SCHEMA;
  ok: true;
  appearance: AppearanceSettings;
  /** What `theme` paints right now; 'unknown' when the OS cannot be asked. */
  resolvedTheme: ReturnType<typeof resolveAppearanceTheme>;
  /** false = nothing saved yet, these are the defaults. */
  saved: boolean;
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

async function view(file: UiAppearanceFile | null, deps: SettingsAppearanceDeps): Promise<AppearanceView> {
  const appearance = appearanceSettingsFrom(file?.appearance);
  const osDark = appearance.theme === 'system' ? await (deps.osPrefersDark ?? macPrefersDark)() : null;
  return {
    schema: SETTINGS_APPEARANCE_SCHEMA,
    ok: true,
    appearance,
    resolvedTheme: resolveAppearanceTheme(appearance.theme, osDark),
    saved: file !== null,
    revision: file?.revision ?? 0,
    updatedAt: file?.updatedAt || null,
    updatedBy: file?.updatedBy ?? null,
  };
}

function print(v: AppearanceView, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(v));
    return;
  }
  const a = v.appearance;
  const theme = a.theme === 'system' ? `system (${v.resolvedTheme} right now)` : a.theme;
  console.log([
    `theme     ${theme}`,
    `accent    ${a.accent}`,
    `density   ${a.density}`,
    `fontSize  ${a.fontSize}`,
    v.saved ? `saved by ${v.updatedBy}${v.updatedAt ? ` at ${v.updatedAt}` : ''}` : 'Nothing saved yet; these are the defaults.',
  ].join('\n'));
}

function fail(message: string, json: boolean, code: number): number {
  if (json) console.log(JSON.stringify({ schema: SETTINGS_APPEARANCE_SCHEMA, ok: false, error: message }));
  else console.error(message);
  return code;
}

export async function cmdSettings(args: string[], deps: SettingsAppearanceDeps = {}): Promise<number> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(json ? JSON.stringify({ usage: USAGE }) : USAGE);
    return 0;
  }
  const rest = args.filter((arg) => arg !== '--json');
  if (rest[0] !== 'appearance') return fail(rest.length === 0 ? USAGE : `Unknown settings area "${rest[0]}".\n${USAGE}`, json, 2);
  const [, verb, key, value, ...extra] = rest;
  // Bare `appearance` reads; `get` stays as an explicit alias.
  if ((verb === undefined || verb === 'get') && key === undefined) {
    print(await view(await readUiAppearanceFile(), deps), json);
    return 0;
  }
  if (verb === '--reset') {
    if (rest.length > 2) return fail('--reset takes no other settings.', json, 2);
    return write(defaultUiAppearance(), json, deps);
  }
  if (verb?.startsWith('--')) {
    const parsed = parseAppearanceFlags(rest.slice(1));
    return parsed.ok ? write(parsed.patch, json, deps) : fail(`${parsed.error}\n${USAGE}`, json, 2);
  }
  if (verb !== 'set' || key === undefined || value === undefined || extra.length > 0) {
    return fail(verb === 'set'
      ? `set needs exactly one key and one value; keys: ${APPEARANCE_SETTING_KEYS.join(', ')}.\n${USAGE}`
      : USAGE, json, 2);
  }
  const checked = validateAppearanceSetting(key, value);
  if (!checked.ok) return fail(checked.error, json, 2);
  return write(checked.patch, json, deps);
}

async function write(patch: object, json: boolean, deps: SettingsAppearanceDeps): Promise<number> {
  const result = await updateUiAppearanceFile(patch, { updatedBy: 'cli' });
  if (!result.ok) return fail('The appearance record changed while writing; run the command again.', json, 1);
  print(await view(result.file, deps), json);
  return 0;
}
