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
 *
 * Reads go through the shared bounded, private, symlink-refusing stable-file
 * reader and writes through the shared atomic private-file writer, so a
 * hostile or merely sloppy `ui.json` (symlink, oversized, unreadable) fails
 * closed instead of being followed or silently replaced.
 */
import { defaultUiSettings, normalizeUiSettings, type UiSettings } from './ui-settings-schema.js';
import { chmodSync, existsSync, lstatSync, mkdirSync, type Stats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readStableRegularFile } from './util/stable-file-read.js';
import { writePrivateFileAtomically } from './util/private-file-write.js';

/** Hard cap on the settings document; the normalized file is ~2 KB. */
export const MAX_UI_SETTINGS_FILE_BYTES = 64 * 1024;

/** Absolute path of the private state root, re-resolved from HOME at call time. */
export function uiSettingsDir(): string {
  return join(homedir(), '.ashlr');
}

/** Absolute path, re-resolved from HOME at call time (tests relocate HOME). */
export function uiSettingsPath(): string {
  return join(uiSettingsDir(), 'ui.json');
}

export interface UiSettingsRead {
  path: string;
  exists: boolean;
  /**
   * False when the file exists but could not be used as a settings document:
   * invalid JSON, oversized, a symlink/non-regular file, or an unsafe or
   * unreadable file. `problems` says which; `settings` is then the defaults.
   */
  parsed: boolean;
  settings: UiSettings;
  problems: string[];
}

function failedRead(path: string, problem: string): UiSettingsRead {
  return { path, exists: true, parsed: false, settings: defaultUiSettings(), problems: [problem] };
}

export function readUiSettings(): UiSettingsRead {
  const path = uiSettingsPath();
  const absent: UiSettingsRead = { path, exists: false, parsed: true, settings: defaultUiSettings(), problems: [] };

  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return absent;
    return failedRead(path, 'file could not be inspected');
  }
  // Never follow a symlink or read anything that is not a plain file.
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return failedRead(path, 'file is not a regular file');
  }

  const loaded = readStableRegularFile(path, {
    anchorPath: uiSettingsDir(),
    maxFileBytes: MAX_UI_SETTINGS_FILE_BYTES,
    remainingBytes: MAX_UI_SETTINGS_FILE_BYTES,
  });
  if (!loaded.ok) {
    const problem =
      loaded.reason === 'per-file-byte-limit' || loaded.reason === 'byte-limit'
        ? 'file exceeds the size limit'
        : loaded.reason === 'unsafe-file' || loaded.reason === 'unsafe-path'
          ? 'file is not a safe regular file'
          : 'file could not be read';
    return failedRead(path, problem);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(loaded.text);
  } catch {
    return failedRead(path, 'file is not valid JSON');
  }
  const { settings, problems } = normalizeUiSettings(doc);
  return { path, exists: true, parsed: true, settings, problems };
}

/** Ensure `~/.ashlr` exists as an owner-only real directory (never a symlink). */
function ensureUiSettingsDir(): void {
  const dir = uiSettingsDir();
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Refusing unsafe UI settings directory');
  }
  chmodSync(dir, 0o700);
}

/**
 * Merge a patch into the file and write it atomically (private temp + rename,
 * so an agent reading mid-write never sees a torn file and the target's
 * directory entry is swapped, never edited in place). The file is rewritten
 * normalized and complete — every key present — so it doubles as the
 * documentation of what can be set. An unparseable or oversized existing file
 * is replaced (the caller just supplied valid intent); invalid patch fields
 * are reported, not written. A symlink or non-regular file at the target is
 * refused outright so a rejected or hostile path is never modified.
 */
export function writeUiSettings(patch: unknown): UiSettingsRead {
  const path = uiSettingsPath();
  ensureUiSettingsDir();

  let existing: Stats | undefined;
  try {
    existing = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error('Refusing to replace unsafe UI settings file');
  }

  const current = readUiSettings();
  const { settings, problems } = normalizeUiSettings(patch, current.settings);
  const json = `${JSON.stringify(settings, null, 2)}\n`;
  if (Buffer.byteLength(json, 'utf8') > MAX_UI_SETTINGS_FILE_BYTES) {
    throw new Error('UI settings document exceeds the size limit');
  }

  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  writePrivateFileAtomically(tmp, path, json, {
    anchorPath: uiSettingsDir(),
    label: 'UI settings file',
  });
  return { path, exists: true, parsed: true, settings, problems };
}

export { defaultUiSettings, normalizeUiSettings, UI_SETTINGS_SCHEMA } from './ui-settings-schema.js';
export type { UiSettings, UiSettingsPatch } from './ui-settings-schema.js';
