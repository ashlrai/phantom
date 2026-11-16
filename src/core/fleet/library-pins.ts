/**
 * Library pins: the short list of Library items Mason marks as important
 * (a project memory, a bus message, a file ref or a note). Pins live in
 * ~/.phantom/library-pins.json, any agent reads them with
 * `ashlr fleet library-pins`, and the fleet context pack carries them.
 *
 * Only refs and titles are stored, never file or message contents. A ref or
 * title that looks like a secret is refused rather than redacted, so the
 * store never holds a credential-shaped string at all.
 */
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { scrubSecrets } from '../util/scrub.js';

export const LIBRARY_PIN_KINDS = ['memory', 'bus', 'file', 'note'] as const;
export type LibraryPinKind = (typeof LIBRARY_PIN_KINDS)[number];
export const LIBRARY_PINS_MAX = 50;
export const LIBRARY_PIN_TITLE_MAX = 160;
export const LIBRARY_PIN_REF_MAX = 512;
const STORE_MAX_BYTES = 256 * 1024;

export interface LibraryPin { id: string; kind: LibraryPinKind; ref: string; title: string; pinnedAt: string }
export interface LibraryPinInput { kind: string; ref: string; title: string }
export interface LibraryPinsOptions { home?: string; now?: () => number }

export class LibraryPinError extends Error {}

export const libraryPinsPath = (home = homedir()): string => join(home, '.phantom', 'library-pins.json');
const ID = /^pin_[a-f0-9]{12}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function validPin(row: unknown): row is LibraryPin {
  if (!row || typeof row !== 'object') return false;
  const pin = row as LibraryPin;
  return typeof pin.id === 'string' && ID.test(pin.id) && (LIBRARY_PIN_KINDS as readonly string[]).includes(pin.kind) &&
    typeof pin.ref === 'string' && typeof pin.title === 'string' && Number.isFinite(Date.parse(pin.pinnedAt));
}

/** Newest first. A missing store is an empty list; a damaged one is an error, never silently reset. */
export function listPins(options: LibraryPinsOptions = {}): LibraryPin[] {
  const file = libraryPinsPath(options.home);
  let text: string;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > STORE_MAX_BYTES) throw new LibraryPinError('Library pins file is not a regular file under 256 KiB. Move it aside and pin again.');
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (error instanceof LibraryPinError) throw error;
    throw new LibraryPinError('Cannot read the library pins file. Check ~/.phantom permissions.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const pins = (parsed as { v?: unknown; pins?: unknown } | null)?.pins;
  if ((parsed as { v?: unknown } | null)?.v !== 1 || !Array.isArray(pins) || !pins.every(validPin)) {
    throw new LibraryPinError('The library pins file is damaged. Move it aside and pin again.');
  }
  return [...pins].sort((a, b) => Date.parse(b.pinnedAt) - Date.parse(a.pinnedAt));
}

function writePins(pins: LibraryPin[], home = homedir()): void {
  const dir = join(home, '.phantom');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.library-pins.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writePrivateFileAtomically(temp, libraryPinsPath(home), `${JSON.stringify({ v: 1, pins }, null, 2)}\n`, { anchorPath: dir, label: 'Library pins' });
}

function field(value: unknown, name: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max || CONTROL.test(text)) throw new LibraryPinError(`${name} must be 1 to ${max} characters on one line.`);
  if (scrubSecrets(text) !== text) throw new LibraryPinError(`${name} looks like a secret. Pin a reference to it instead.`);
  return text;
}

/** Validate untrusted input; throws LibraryPinError with a sentence the caller can show. */
export function parsePinInput(input: Partial<LibraryPinInput>): LibraryPinInput & { kind: LibraryPinKind } {
  if (!(LIBRARY_PIN_KINDS as readonly unknown[]).includes(input.kind)) throw new LibraryPinError(`kind must be one of ${LIBRARY_PIN_KINDS.join(', ')}.`);
  return { kind: input.kind as LibraryPinKind, ref: field(input.ref, 'ref', LIBRARY_PIN_REF_MAX), title: field(input.title, 'title', LIBRARY_PIN_TITLE_MAX) };
}

/** Pin once per kind+ref (a repeat returns the existing pin); past the cap the oldest pin is dropped. */
export function addPin(input: Partial<LibraryPinInput>, options: LibraryPinsOptions = {}): LibraryPin {
  const { kind, ref, title } = parsePinInput(input);
  const pins = listPins(options);
  const existing = pins.find((pin) => pin.kind === kind && pin.ref === ref);
  if (existing) return existing;
  const pin: LibraryPin = { id: `pin_${randomBytes(6).toString('hex')}`, kind, ref, title, pinnedAt: new Date((options.now ?? Date.now)()).toISOString() };
  writePins([pin, ...pins].slice(0, LIBRARY_PINS_MAX), options.home);
  return pin;
}

/** True when a pin was removed, false when no pin had that id. */
export function removePin(id: string, options: LibraryPinsOptions = {}): boolean {
  const pins = listPins(options);
  const kept = pins.filter((pin) => pin.id !== id);
  if (kept.length === pins.length) return false;
  writePins(kept, options.home);
  return true;
}

/** Context-pack rows: titles and refs only, newest first; an unreadable store adds nothing. */
export function pinnedContextRows(limit = 10, options: LibraryPinsOptions = {}): { kind: LibraryPinKind; title: string; ref: string }[] {
  try { return listPins(options).slice(0, limit).map(({ kind, title, ref }) => ({ kind, title, ref })); } catch { return []; }
}
