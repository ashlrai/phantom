/**
 * ui-settings-schema.ts — the pure half of ~/.ashlr/ui.json: the schema,
 * defaults and the total, never-throwing normalizer. No node: imports, so the
 * web UI bundles it too (one definition of "valid" for the file, the server
 * and the browser). File IO lives in ./ui-settings.ts.
 */

export type UiSettingsField =
  | { kind: 'enum'; values: readonly string[]; def: string }
  | { kind: 'int'; min: number; max: number; def: number; wrap?: boolean }
  | { kind: 'bool'; def: boolean };

/** The schema. Defaults mirror web-ui/data/appearance-store.ts and verse-ui-store.ts. */
export const UI_SETTINGS_SCHEMA = {
  appearance: {
    theme: { kind: 'enum', values: ['system', 'light', 'dark', 'high-contrast'], def: 'system' },
    accentH: { kind: 'int', min: 0, max: 359, def: 245, wrap: true },
    accentS: { kind: 'int', min: 0, max: 100, def: 72 },
    accentL: { kind: 'int', min: 30, max: 78, def: 58 },
    density: { kind: 'enum', values: ['comfortable', 'compact'], def: 'comfortable' },
    uiScale: { kind: 'enum', values: ['default', 'large', 'xlarge'], def: 'default' },
    displayFont: { kind: 'enum', values: ['grotesk', 'ui', 'mono'], def: 'grotesk' },
    radius: { kind: 'enum', values: ['sharp', 'default', 'soft'], def: 'default' },
    layout: { kind: 'enum', values: ['auto', 'wide', 'narrow'], def: 'auto' },
    motion: { kind: 'enum', values: ['system', 'reduce', 'full'], def: 'system' },
  },
  layout: {
    sidebarWidth: { kind: 'int', min: 240, max: 360, def: 264 },
    sidebarCollapsed: { kind: 'bool', def: false },
    resourcesOpen: { kind: 'bool', def: true },
    resourcesWidth: { kind: 'int', min: 260, max: 480, def: 320 },
    railExpanded: { kind: 'bool', def: false },
  },
} as const satisfies Record<string, Record<string, UiSettingsField>>;

export type UiSettingsGroup = keyof typeof UI_SETTINGS_SCHEMA;
export type UiSettings = { [G in UiSettingsGroup]: Record<string, string | number | boolean> };
/** A partial document: any subset of groups, any subset of keys. */
export type UiSettingsPatch = { [G in UiSettingsGroup]?: Record<string, unknown> };

export function defaultUiSettings(): UiSettings {
  const out: Record<string, Record<string, string | number | boolean>> = {};
  for (const [group, fields] of Object.entries(UI_SETTINGS_SCHEMA)) {
    out[group] = Object.fromEntries(Object.entries(fields as Record<string, UiSettingsField>).map(([k, f]) => [k, f.def]));
  }
  return out as UiSettings;
}

function coerce(field: UiSettingsField, value: unknown): string | number | boolean | undefined {
  switch (field.kind) {
    case 'enum':
      return typeof value === 'string' && field.values.includes(value) ? value : undefined;
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
    case 'int': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      const n = Math.round(value);
      if (field.wrap) return ((n % 360) + 360) % 360;
      return Math.min(field.max, Math.max(field.min, n));
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Merge `patch` over `base` (defaults when omitted), coercing each field.
 * Unknown groups/keys and wrong-typed values are dropped and listed in
 * `problems`; out-of-range numbers are clamped silently (a clamp is not an error).
 */
export function normalizeUiSettings(
  patch: unknown,
  base: UiSettings = defaultUiSettings(),
): { settings: UiSettings; problems: string[] } {
  const problems: string[] = [];
  const settings: UiSettings = { appearance: { ...base.appearance }, layout: { ...base.layout } };
  if (!isRecord(patch)) {
    if (patch !== undefined) problems.push('document must be a JSON object');
    return { settings, problems };
  }
  for (const [group, body] of Object.entries(patch)) {
    const fields = (UI_SETTINGS_SCHEMA as Record<string, Record<string, UiSettingsField>>)[group];
    if (!fields) {
      problems.push(`unknown group "${group}"`);
      continue;
    }
    if (!isRecord(body)) {
      problems.push(`"${group}" must be an object`);
      continue;
    }
    for (const [key, raw] of Object.entries(body)) {
      const field = fields[key];
      if (!field) {
        problems.push(`unknown setting "${group}.${key}"`);
        continue;
      }
      const value = coerce(field, raw);
      if (value === undefined) problems.push(`invalid value for "${group}.${key}"`);
      else settings[group as UiSettingsGroup][key] = value;
    }
  }
  return { settings, problems };
}

