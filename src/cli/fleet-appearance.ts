/**
 * `ashlr fleet appearance` — read and set the desktop app's appearance.
 *
 *   ashlr fleet appearance [--json]
 *   ashlr fleet appearance set --theme dark [--density compact] [--accent-hue N]
 *      [--accent-sat N] [--accent-light N] [--ui-scale S] [--font F]
 *      [--radius R] [--layout L] [--motion M] [--by NAME] [--json]
 *
 * Reads and writes <ASHLR_RUNS_DIR or ~/.ashlr-runs>/ui/appearance.json through
 * core/verse/ui-appearance-file.ts — no server needed. An open desktop app
 * picks the change up on its next poll (web-ui/data/appearance-sync.ts).
 * Enum flags exit 2 on a value outside their set; numeric flags accept any
 * finite number and coerce exactly as the web store does (hue wraps mod 360,
 * saturation clamps 0-100, lightness clamps 30-78).
 */
import {
  readUiAppearanceFile,
  updateUiAppearanceFile,
  UI_DENSITIES,
  UI_DISPLAY_FONTS,
  UI_LAYOUTS,
  UI_MOTIONS,
  UI_RADII,
  UI_SCALES,
  UI_THEMES,
  type UiAppearance,
  type UiAppearanceFile,
} from '../core/verse/ui-appearance-file.js';

const USAGE = `Usage: ashlr fleet appearance [--json]
       ashlr fleet appearance set [--by NAME] [--json]
         --theme ${UI_THEMES.join('|')}
         --density ${UI_DENSITIES.join('|')}
         --ui-scale ${UI_SCALES.join('|')}
         --font ${UI_DISPLAY_FONTS.join('|')}
         --radius ${UI_RADII.join('|')}
         --layout ${UI_LAYOUTS.join('|')}
         --motion ${UI_MOTIONS.join('|')}
         --accent-hue N (wraps mod 360)  --accent-sat N (0-100)  --accent-light N (30-78)
Read and set the desktop app's shared appearance record. A running app applies it live.`;

const ENUM_FLAGS: Record<string, { field: keyof UiAppearance; values: readonly string[] }> = {
  '--theme': { field: 'theme', values: UI_THEMES },
  '--density': { field: 'density', values: UI_DENSITIES },
  '--ui-scale': { field: 'uiScale', values: UI_SCALES },
  '--font': { field: 'displayFont', values: UI_DISPLAY_FONTS },
  '--radius': { field: 'radius', values: UI_RADII },
  '--layout': { field: 'layout', values: UI_LAYOUTS },
  '--motion': { field: 'motion', values: UI_MOTIONS },
};
const NUMBER_FLAGS: Record<string, keyof UiAppearance> = {
  '--accent-hue': 'accentH',
  '--accent-sat': 'accentS',
  '--accent-light': 'accentL',
};
const BY_MAX = 120;

function empty(): { revision: 0; appearance: null } {
  return { revision: 0, appearance: null };
}

function format(file: UiAppearanceFile | ReturnType<typeof empty>): string {
  if (file.appearance === null) return 'No appearance recorded yet (revision 0).';
  const a = file.appearance;
  const stored = file as UiAppearanceFile;
  return [
    `revision ${stored.revision}${stored.updatedAt ? `, updated ${stored.updatedAt}` : ''} by ${stored.updatedBy}`,
    `theme ${a.theme}  density ${a.density}  ui-scale ${a.uiScale}  font ${a.displayFont}`,
    `radius ${a.radius}  layout ${a.layout}  motion ${a.motion}`,
    `accent hue ${a.accentH}  sat ${a.accentS}%  light ${a.accentL}%`,
  ].join('\n');
}

function print(value: UiAppearanceFile | ReturnType<typeof empty>, json: boolean): void {
  console.log(json ? JSON.stringify(value) : format(value));
}

export async function cmdFleetAppearance(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args.length === 0 || (args.length === 1 && args[0] === '--json')) {
    print((await readUiAppearanceFile()) ?? empty(), args.includes('--json'));
    return 0;
  }
  if (args[0] !== 'set') {
    console.error(USAGE);
    return 2;
  }
  const patch: Record<string, unknown> = {};
  let by: string | undefined;
  let json = false;
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--json') { json = true; continue; }
    const value = rest[++i];
    if (flag === '--by') {
      if (value === undefined || value.startsWith('--') || value.length === 0 || value.length > BY_MAX) {
        console.error(`--by needs a name of 1-${BY_MAX} characters.\n${USAGE}`);
        return 2;
      }
      by = value;
      continue;
    }
    if (flag in ENUM_FLAGS) {
      const { field, values } = ENUM_FLAGS[flag]!;
      if (value === undefined || !values.includes(value)) {
        console.error(`${flag} must be one of: ${values.join(', ')}.`);
        return 2;
      }
      patch[field] = value;
      continue;
    }
    if (flag in NUMBER_FLAGS) {
      const n = value === undefined ? Number.NaN : Number(value);
      if (!Number.isFinite(n)) {
        console.error(`${flag} needs a finite number.`);
        return 2;
      }
      patch[NUMBER_FLAGS[flag]!] = n;
      continue;
    }
    console.error(`Unknown flag: ${flag}.\n${USAGE}`);
    return 2;
  }
  if (Object.keys(patch).length === 0) {
    console.error(`set needs at least one appearance flag.\n${USAGE}`);
    return 2;
  }
  const result = await updateUiAppearanceFile(patch, { updatedBy: by ?? 'cli' });
  if (!result.ok) {
    console.error('The appearance record changed while writing; retry.');
    return 1;
  }
  print(result.file, json);
  return 0;
}
