/**
 * ui-settings.ts — the desktop/web UI's customization, as ONE file.
 *
 * `~/.ashlr/ui.json` is the single source of truth for every setting that
 * belongs to the operator rather than to a browser profile: appearance
 * (theme, accent, density, ...) and layout (sidebar/resources width, panel
 * visibility). The Settings view writes it through `PUT /api/ui-settings`;
 * an agent (or a human with an editor) edits the same file and the UI picks
 * the change up on the next load or "Reload from file". The browser keeps a
 * localStorage copy only as a first-paint cache — the file wins.
 *
 * Deliberately a file separate from config.json: it holds no secrets and no
 * authority, so a malformed edit can only ever cost a cosmetic fallback, and
 * `saveConfig`'s heavier validation is not on the path of a slider drag.
 *
 * Shape (all keys optional; unknown keys are dropped and reported):
 *   { "appearance": { "theme": "dark", "density": "compact", ... },
 *     "layout":     { "sidebarWidth": 300, "resourcesOpen": false, ... } }
 *
 * Total by construction: `normalizeUiSettings` never throws, coerces every
 * field into its range, and returns human-readable `problems` for anything it
 * had to drop so an agent editing the file gets feedback, not silence.
 */
import { defaultUiSettings, normalizeUiSettings, type UiSettings } from './ui-settings-schema.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Absolute path, re-resolved from HOME at call time (tests relocate HOME). */
export function uiSettingsPath(): string {
  return join(homedir(), '.ashlr', 'ui.json');
}

export interface UiSettingsRead {
  path: string;
  exists: boolean;
  /** False when the file exists but is not valid JSON; settings are then defaults. */
  parsed: boolean;
  settings: UiSettings;
  problems: string[];
}

export function readUiSettings(): UiSettingsRead {
  const path = uiSettingsPath();
  if (!existsSync(path)) return { path, exists: false, parsed: true, settings: defaultUiSettings(), problems: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { path, exists: true, parsed: false, settings: defaultUiSettings(), problems: ['file is not valid JSON'] };
  }
  const { settings, problems } = normalizeUiSettings(doc);
  return { path, exists: true, parsed: true, settings, problems };
}

/**
 * Merge a patch into the file and write it atomically (tmp + rename, so an
 * agent reading mid-write never sees a torn file). The file is rewritten
 * normalized and complete — every key present — so it doubles as the
 * documentation of what can be set. An unparseable existing file is replaced
 * (the caller just supplied valid intent); invalid patch fields are reported,
 * not written.
 */
export function writeUiSettings(patch: unknown): UiSettingsRead {
  const current = readUiSettings();
  const { settings, problems } = normalizeUiSettings(patch, current.settings);
  const path = current.path;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  return { path, exists: true, parsed: true, settings, problems };
}

export { defaultUiSettings, normalizeUiSettings, UI_SETTINGS_SCHEMA } from './ui-settings-schema.js';
export type { UiSettings, UiSettingsPatch } from './ui-settings-schema.js';
