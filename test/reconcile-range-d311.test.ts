/**
 * reconcile-range-d311.test.ts — executable evidence for the RQ-PHX-
 * RANGERECONCILED311C carry of PR #5034 (RQ-PHX-SETTINGSPERSISTRECOVER141,
 * head dbb6b122674637df8372f0212d9c7fb1d091a2bf).
 *
 * The carried behavior lives in src/core/ui-settings.ts and is exercised here
 * through its REAL exported entry points, `readUiSettings` and
 * `writeUiSettings` — no seams, no mocks. Each case fails if the fail-closed
 * file handling is removed (the old plain readFileSync/renameSync version
 * follows symlinks, reads unbounded, and replaces a link in place):
 *   - a symlinked ui.json reports 'file is not a regular file' and the link
 *     target's document is never read;
 *   - an oversized ui.json reports 'file exceeds the size limit' instead of
 *     being parsed;
 *   - writeUiSettings refuses to replace a symlinked ui.json, leaves the link
 *     itself and the target bytes untouched;
 *   - writeUiSettings refuses a symlinked ~/.ashlr directory;
 *   - a normal write lands atomically as an owner-only regular file and reads
 *     back the merged values.
 *
 * Hermetic: HOME is relocated to a per-test tmp dir; all values are fake.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_UI_SETTINGS_FILE_BYTES,
  readUiSettings,
  uiSettingsDir,
  uiSettingsPath,
  writeUiSettings,
} from '../src/core/ui-settings.js';

let home: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reconcile-d311-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  rmSync(home, { recursive: true, force: true });
});

function seedUiJson(text: string): void {
  mkdirSync(uiSettingsDir(), { recursive: true });
  writeFileSync(uiSettingsPath(), text, 'utf8');
}

describe('readUiSettings fails closed', () => {
  it('a symlinked ui.json is refused and its target document is never read', () => {
    mkdirSync(uiSettingsDir(), { recursive: true });
    const target = join(home, 'fake-elsewhere.json');
    writeFileSync(target, JSON.stringify({ appearance: { theme: 'light' } }), 'utf8');
    symlinkSync(target, uiSettingsPath());

    const read = readUiSettings();
    expect(read.exists).toBe(true);
    expect(read.parsed).toBe(false);
    expect(read.problems).toEqual(['file is not a regular file']);
    // The target's theme never leaks into the returned settings.
    expect(read.settings.appearance.theme).not.toBe('light');
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify({ appearance: { theme: 'light' } }));
  });

  it('an oversized ui.json is refused with a size problem, not parsed', () => {
    seedUiJson(`{"pad":"${'x'.repeat(MAX_UI_SETTINGS_FILE_BYTES + 1024)}"}`);

    const read = readUiSettings();
    expect(read.parsed).toBe(false);
    expect(read.problems).toEqual(['file exceeds the size limit']);
    expect(JSON.stringify(read.problems)).not.toContain(home);
  });

  it('MAX_UI_SETTINGS_FILE_BYTES is the exported 64 KiB bound', () => {
    expect(MAX_UI_SETTINGS_FILE_BYTES).toBe(64 * 1024);
  });
});

describe('writeUiSettings fails closed', () => {
  it('refuses to replace a symlinked ui.json; link and target are untouched', () => {
    mkdirSync(uiSettingsDir(), { recursive: true });
    const target = join(home, 'fake-target.json');
    const targetBytes = JSON.stringify({ appearance: { theme: 'dark' } });
    writeFileSync(target, targetBytes, 'utf8');
    symlinkSync(target, uiSettingsPath());

    expect(() => writeUiSettings({ appearance: { theme: 'light' } })).toThrow(/unsafe UI settings/);
    expect(lstatSync(uiSettingsPath()).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(targetBytes);
  });

  it('refuses a symlinked ~/.ashlr directory', () => {
    const real = join(home, 'fake-real-ashlr');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, uiSettingsDir(), 'dir');

    expect(() => writeUiSettings({ appearance: { theme: 'dark' } })).toThrow(/unsafe UI settings directory/);
    expect(readdirSync(real)).toEqual([]);
  });
});

describe('writeUiSettings happy path', () => {
  it('writes an owner-only regular ui.json atomically and reads it back', () => {
    const written = writeUiSettings({ appearance: { theme: 'dark', density: 'compact' } });
    expect(written.problems).toEqual([]);

    const stat = lstatSync(uiSettingsPath());
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o077).toBe(0);
    // Atomic publish: no tmp litter remains beside the document.
    expect(readdirSync(uiSettingsDir())).toEqual(['ui.json']);

    const read = readUiSettings();
    expect(read.parsed).toBe(true);
    expect(read.settings.appearance).toMatchObject({ theme: 'dark', density: 'compact' });
  });
});
