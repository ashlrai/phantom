/**
 * core/verse/ui-appearance-file.ts — the desktop app's appearance as a shared
 * server-side record: `<runs dir>/ui/appearance.json`. Agents read and write it
 * through `ashlr fleet appearance` or `PUT /api/verse/appearance`; an open
 * desktop app polls the route (web-ui/data/appearance-sync.ts) and applies a
 * newer revision live.
 *
 * The appearance fields are a COPY of web-ui/data/appearance-store.ts's stored
 * shape (everything but the derived `reduceMotion`) — web-ui code is never
 * imported into core, so the enum sets and clamps are duplicated here and a
 * test (test/ui-appearance-file-119.test.ts) reads the web module as text to
 * prove the two stay in step. Normalization coerces unknown or out-of-range
 * values exactly as the web store's normalize() does: each invalid field falls
 * back to its own constant default, never to the base's value.
 *
 * File shape: `{ version: 1, revision, updatedAt, updatedBy, appearance }`.
 * `revision` is the optimistic-concurrency counter a PUT cas against. A
 * missing or corrupt file reads as `null` — never a throw — so every reader
 * treats "no record yet" identically. Writes are atomic (tmp + rename), the
 * file 0600 and the directory 0700, the same posture as the Leader attachment
 * store.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const UI_THEMES = ['system', 'light', 'dark', 'high-contrast'] as const;
export const UI_DENSITIES = ['comfortable', 'compact'] as const;
export const UI_SCALES = ['default', 'large', 'xlarge'] as const;
export const UI_DISPLAY_FONTS = ['grotesk', 'ui', 'mono'] as const;
export const UI_RADII = ['sharp', 'default', 'soft'] as const;
export const UI_LAYOUTS = ['auto', 'wide', 'narrow'] as const;
export const UI_MOTIONS = ['system', 'reduce', 'full'] as const;

export type UiTheme = (typeof UI_THEMES)[number];
export type UiDensity = (typeof UI_DENSITIES)[number];
export type UiScale = (typeof UI_SCALES)[number];
export type UiDisplayFont = (typeof UI_DISPLAY_FONTS)[number];
export type UiRadius = (typeof UI_RADII)[number];
export type UiLayout = (typeof UI_LAYOUTS)[number];
export type UiMotion = (typeof UI_MOTIONS)[number];

/** The stored appearance: the web `Appearance` minus derived `reduceMotion`. */
export interface UiAppearance {
  theme: UiTheme;
  /** Accent hue 0-359 (any finite input wraps). */
  accentH: number;
  /** Accent saturation 0-100 (%). */
  accentS: number;
  /** Accent lightness, clamped to a readable band (%). */
  accentL: number;
  density: UiDensity;
  uiScale: UiScale;
  displayFont: UiDisplayFont;
  radius: UiRadius;
  layout: UiLayout;
  /** 'system' follows the OS `prefers-reduced-motion`. */
  motion: UiMotion;
}

export interface UiAppearanceFile {
  version: 1;
  revision: number;
  /** ISO timestamp of the write. */
  updatedAt: string;
  /** Who wrote it: a CLI `--by` name, 'verse-ui', an agent id. */
  updatedBy: string;
  appearance: UiAppearance;
}

/** Mirrors DEFAULT_ACCENT in web-ui/data/appearance-store.ts. */
export const UI_DEFAULT_ACCENT = { h: 245, s: 72, l: 58 } as const;
/** Mirrors ACCENT_L_MIN/MAX in the web store (the readable band). */
export const UI_ACCENT_L_MIN = 30;
export const UI_ACCENT_L_MAX = 78;

export function defaultUiAppearance(): UiAppearance {
  return {
    theme: 'system',
    accentH: UI_DEFAULT_ACCENT.h,
    accentS: UI_DEFAULT_ACCENT.s,
    accentL: UI_DEFAULT_ACCENT.l,
    density: 'comfortable',
    uiScale: 'default',
    displayFont: 'grotesk',
    radius: 'default',
    layout: 'auto',
    motion: 'system',
  };
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

const member = <T extends string>(values: readonly T[]) =>
  (v: unknown): v is T => (values as readonly string[]).includes(v as string);

const isDensity = member(UI_DENSITIES);
const isUiScale = member(UI_SCALES);
const isDisplayFont = member(UI_DISPLAY_FONTS);
const isRadius = member(UI_RADII);
const isLayout = member(UI_LAYOUTS);
const isMotion = member(UI_MOTIONS);

/**
 * Coerce anything (a stored blob, an API body's `appearance`, CLI patch fields)
 * into a valid UiAppearance, exactly as the web store's normalize() does —
 * including its `reduceMotion` back-channel: a boolean `reduceMotion` in the
 * patch maps to 'reduce'/'full' only when `motion` itself is not explicit.
 * Every invalid field falls back to its constant default, NOT the base value.
 */
export function normalizeUiAppearance(base: UiAppearance, patch: unknown): UiAppearance {
  const p = patch !== null && typeof patch === 'object' && !Array.isArray(patch)
    ? (patch as Record<string, unknown>)
    : {};
  const merged: Record<string, unknown> = { ...base, ...p };
  const asked = p['reduceMotion'];
  const motion: UiMotion = isMotion(p['motion'])
    ? p['motion']
    : typeof asked === 'boolean'
      ? (asked ? 'reduce' : 'full')
      : isMotion(base.motion)
        ? base.motion
        : 'system';
  const accentH = typeof merged.accentH === 'number' && Number.isFinite(merged.accentH)
    ? ((Math.round(merged.accentH) % 360) + 360) % 360
    : UI_DEFAULT_ACCENT.h;
  return {
    theme: merged.theme === 'light' || merged.theme === 'dark' || merged.theme === 'high-contrast' ? merged.theme : 'system',
    accentH,
    accentS: typeof merged.accentS === 'number' && Number.isFinite(merged.accentS)
      ? clamp(Math.round(merged.accentS), 0, 100)
      : UI_DEFAULT_ACCENT.s,
    accentL: typeof merged.accentL === 'number' && Number.isFinite(merged.accentL)
      ? clamp(Math.round(merged.accentL), UI_ACCENT_L_MIN, UI_ACCENT_L_MAX)
      : UI_DEFAULT_ACCENT.l,
    density: isDensity(merged.density) ? merged.density : 'comfortable',
    uiScale: isUiScale(merged.uiScale) ? merged.uiScale : 'default',
    displayFont: isDisplayFont(merged.displayFont) ? merged.displayFont : 'grotesk',
    radius: isRadius(merged.radius) ? merged.radius : 'default',
    layout: isLayout(merged.layout) ? merged.layout : 'auto',
    motion,
  };
}

function runsDir(): string {
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

/** `<runs dir>/ui/appearance.json` — the ONE shared appearance record. */
export function uiAppearancePath(): string {
  return join(runsDir(), 'ui', 'appearance.json');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseFile(value: unknown): UiAppearanceFile | null {
  if (!isRecord(value) || value['version'] !== 1) return null;
  const revision = value['revision'];
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null;
  if (!isRecord(value['appearance'])) return null;
  return {
    version: 1,
    revision,
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : '',
    updatedBy: typeof value['updatedBy'] === 'string' && value['updatedBy'] ? value['updatedBy'] : 'unknown',
    appearance: normalizeUiAppearance(defaultUiAppearance(), value['appearance']),
  };
}

/**
 * Read the shared record. `null` covers every failure — absent file, corrupt
 * JSON, wrong shape — so a reader never has to catch. Out-of-range appearance
 * values are normalized, not treated as corruption.
 */
export async function readUiAppearanceFile(): Promise<UiAppearanceFile | null> {
  try {
    return parseFile(JSON.parse(await readFile(uiAppearancePath(), 'utf8')));
  } catch {
    return null;
  }
}

async function writeRecord(record: UiAppearanceFile): Promise<void> {
  const path = uiAppearancePath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const tmp = join(dir, `.appearance.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

// In-process updates are serialized so the revision check and the write are a
// real compare-and-swap for every caller in this process (the API and the CLI
// share the module). Cross-process races stay possible; the revision counter
// is how clients detect them.
let queue: Promise<unknown> = Promise.resolve();

export type UiAppearanceUpdateResult =
  | { ok: true; file: UiAppearanceFile }
  | { ok: false; conflict: UiAppearanceFile | null };

/**
 * Merge `patch` over the stored appearance (defaults when none) and write
 * revision+1. When `expectedRevision` is given and differs from the stored
 * revision (0 when no file), nothing is written and the stored record comes
 * back as `conflict`.
 */
export function updateUiAppearanceFile(
  patch: unknown,
  opts: { expectedRevision?: number; updatedBy?: string; now?: () => Date } = {},
): Promise<UiAppearanceUpdateResult> {
  const run = queue.then(async (): Promise<UiAppearanceUpdateResult> => {
    const stored = await readUiAppearanceFile();
    const current = stored?.revision ?? 0;
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== current) {
      return { ok: false, conflict: stored };
    }
    const file: UiAppearanceFile = {
      version: 1,
      revision: current + 1,
      updatedAt: (opts.now?.() ?? new Date()).toISOString(),
      updatedBy: opts.updatedBy && opts.updatedBy.length > 0 ? opts.updatedBy : 'unknown',
      appearance: normalizeUiAppearance(stored?.appearance ?? defaultUiAppearance(), patch),
    };
    await writeRecord(file);
    return { ok: true, file };
  });
  queue = run.catch(() => undefined);
  return run;
}
