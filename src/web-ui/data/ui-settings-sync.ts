/**
 * data/ui-settings-sync.ts — keeps the browser's appearance + layout stores
 * and ~/.ashlr/ui.json (core/ui-settings.ts) as ONE thing.
 *
 * The file is the source of truth. localStorage (appearance-store,
 * verse-ui-store) stays only as the first-paint cache those stores already
 * were, so the shell never flashes defaults while this module's request is in
 * flight. Once the read session exists:
 *
 *   file → UI   GET /api/ui-settings, then apply it over both stores. This is
 *               what makes an agent's edit to the file show up on reload (or on
 *               "Reload from file" in Settings).
 *   UI → file   every later change to either store is debounced into one PUT.
 *   migration   a file that does not exist yet is seeded from whatever the
 *               stores hold, once, so existing customizations are not lost —
 *               but only when they differ from the defaults.
 *
 * Echo loops are impossible by construction: the last document known to be on
 * disk is `lastFile`; a store change only PUTs when the store slice differs
 * from it, and applying the file first records it as `lastFile`.
 *
 * Writes need the mutation token and a server started with --allow-dispatch.
 * Without them the UI still works (local cache) and `status` says why the file
 * is not being updated, so the Settings panel can tell the operator instead of
 * silently diverging.
 */
import { useSyncExternalStore } from 'react';
import {
  defaultUiSettings,
  normalizeUiSettings,
  UI_SETTINGS_SCHEMA,
  type UiSettings,
} from '../../core/ui-settings-schema.js';
import { ApiError, apiGet, apiPut } from './client.js';
import { isRemoteMobileMode } from './remote-mode.js';
import { getAuthSnapshot, getMutationToken, subscribeAuth } from './auth-store.js';

export const UI_SETTINGS_ENDPOINT = '/api/ui-settings';
export const PUSH_DEBOUNCE_MS = 400;

interface FileRead {
  path: string;
  exists: boolean;
  parsed: boolean;
  settings: UiSettings;
  problems: string[];
}

export type UiSettingsPhase =
  /** Not yet read (booting, or no read session). */
  | 'idle'
  /** The UI matches the file. */
  | 'synced'
  /** A change is waiting for its PUT. */
  | 'saving'
  /** Changes exist that the file does not have, and why (see `detail`). */
  | 'local-only';

export interface UiSettingsStatus {
  phase: UiSettingsPhase;
  /** Absolute path of the file, once the server has said. */
  path: string | null;
  exists: boolean;
  /** Things the server dropped from the file, in words an agent can act on. */
  problems: readonly string[];
  /** Why `local-only`, or null. */
  detail: string | null;
}

let status: UiSettingsStatus = { phase: 'idle', path: null, exists: false, problems: [], detail: null };
const listeners = new Set<() => void>();

function setStatus(patch: Partial<UiSettingsStatus>): void {
  status = { ...status, ...patch };
  for (const l of listeners) l();
}
export function getUiSettingsStatus(): UiSettingsStatus {
  return status;
}
export function subscribeUiSettingsStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useUiSettingsStatus(): UiSettingsStatus {
  return useSyncExternalStore(subscribeUiSettingsStatus, getUiSettingsStatus, getUiSettingsStatus);
}

// ---------------------------------------------------------------------------
// Stores ↔ document
// ---------------------------------------------------------------------------

type Stores = {
  appearance: typeof import('./appearance-store.js');
  verse: typeof import('../routes/verse/verse-ui-store.js');
};

/** Loaded on demand: the full appearance store is otherwise a Settings-only chunk. */
async function loadStores(): Promise<Stores> {
  const [appearance, verse] = await Promise.all([
    import('./appearance-store.js'),
    import('../routes/verse/verse-ui-store.js'),
  ]);
  return { appearance, verse };
}

/** What the two stores hold right now, in the file's shape. */
export function readStores(s: Stores): UiSettings {
  const a = s.appearance.getAppearance();
  const v = s.verse.getVerseUiState();
  const doc = defaultUiSettings();
  for (const key of Object.keys(UI_SETTINGS_SCHEMA.appearance)) {
    doc.appearance[key] = (a as unknown as Record<string, string | number | boolean>)[key]!;
  }
  for (const key of Object.keys(UI_SETTINGS_SCHEMA.layout)) {
    doc.layout[key] = (v as unknown as Record<string, string | number | boolean>)[key]!;
  }
  return doc;
}

/** Apply a file's settings over both stores (their setters clamp and persist the cache). */
export function applyToStores(s: Stores, doc: UiSettings): void {
  s.appearance.setAppearance(doc.appearance as Partial<import('./appearance-store.js').Appearance>);
  const l = doc.layout as Record<string, number | boolean>;
  s.verse.setVerseSidebarWidth(l['sidebarWidth'] as number);
  s.verse.setVerseSidebarCollapsed(l['sidebarCollapsed'] as boolean);
  s.verse.setVerseResourcesOpen(l['resourcesOpen'] as boolean);
  s.verse.setVerseResourcesWidth(l['resourcesWidth'] as number);
  s.verse.setVerseRailExpanded(l['railExpanded'] as boolean);
}

const same = (a: UiSettings, b: UiSettings): boolean => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------

let stores: Stores | null = null;
/** The last document known to be on disk. */
let lastFile: UiSettings | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let unsubscribers: Array<() => void> = [];

function noteRead(read: FileRead): void {
  lastFile = read.settings;
  setStatus({ path: read.path, exists: read.exists, problems: read.problems });
}

/** Read the file and apply it to the UI. Resolves the stores it applied to. */
async function pull(seedIfMissing: boolean): Promise<void> {
  const [read, s] = await Promise.all([apiGet<FileRead>(UI_SETTINGS_ENDPOINT), stores ? Promise.resolve(stores) : loadStores()]);
  stores = s;
  const local = readStores(s);
  if (!read.exists && seedIfMissing && !same(local, defaultUiSettings())) {
    // First run of the file: the stores hold the operator's earlier choices.
    noteRead({ ...read, settings: defaultUiSettings() });
    await push();
    return;
  }
  noteRead(read);
  applyToStores(s, read.settings);
  setStatus({ phase: 'synced', detail: null });
}

async function push(): Promise<void> {
  if (!stores || !lastFile) return;
  const local = readStores(stores);
  if (same(local, lastFile)) {
    setStatus({ phase: 'synced', detail: null });
    return;
  }
  const token = getMutationToken();
  if (!token) {
    setStatus({ phase: 'local-only', detail: 'Unlock mutations to write changes to the file.' });
    return;
  }
  setStatus({ phase: 'saving' });
  try {
    const written = await apiPut<FileRead>(UI_SETTINGS_ENDPOINT, local, token);
    noteRead(written);
    setStatus({ phase: same(readStores(stores), written.settings) ? 'synced' : 'saving', detail: null });
  } catch (err) {
    const gated = err instanceof ApiError && (err.status === 404 || err.status === 401);
    setStatus({
      phase: 'local-only',
      detail: gated
        ? err.status === 401 ? 'The mutation token was rejected.' : 'This server was started without --allow-dispatch, so it cannot write the file.'
        : 'Could not reach the server to write the file.',
    });
  }
}

function schedulePush(): void {
  if (timer !== null) clearTimeout(timer);
  setStatus({ phase: 'saving' });
  timer = setTimeout(() => {
    timer = null;
    void push();
  }, PUSH_DEBOUNCE_MS);
}

/**
 * Begin syncing once the read session exists. Idempotent; safe to call from
 * every app entry. Failures leave the stores' local cache in charge.
 */
export function startUiSettingsSync(): void {
  if (started || typeof window === 'undefined' || isRemoteMobileMode()) return;
  started = true;
  let pulled = false;
  const begin = async () => {
    if (pulled || getAuthSnapshot().phase !== 'authenticated') return;
    pulled = true;
    try {
      await pull(true);
      const s = stores!;
      unsubscribers.push(s.appearance.subscribeAppearance(() => onStoreChange()));
      unsubscribers.push(s.verse.subscribeVerseUi(() => onStoreChange()));
    } catch {
      pulled = false; // e.g. an older server without the route; retried on the next auth change
      setStatus({ phase: 'local-only', detail: 'The server did not return the settings file.' });
    }
  };
  const onStoreChange = () => {
    if (stores && lastFile && !same(readStores(stores), lastFile)) schedulePush();
  };
  unsubscribers.push(subscribeAuth(() => { void begin(); if (getMutationToken() && status.phase === 'local-only') onStoreChange(); }));
  void begin();
}

/** Settings ▸ "Reload from file": drop UI state in favour of what the file says now. */
export async function reloadUiSettingsFromFile(): Promise<void> {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  await pull(false);
}

/**
 * Settings ▸ raw editor: validate the text the operator typed against the
 * shared schema, write it, and apply what the server accepted. Returns the
 * problems found (empty on a clean save); a syntax error writes nothing.
 */
export async function saveUiSettingsText(text: string): Promise<{ ok: boolean; problems: string[] }> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['not valid JSON'] };
  }
  const { problems } = normalizeUiSettings(doc);
  const token = getMutationToken();
  if (!token) return { ok: false, problems: ['Unlock mutations to write the file.', ...problems] };
  try {
    const written = await apiPut<FileRead>(UI_SETTINGS_ENDPOINT, doc, token);
    stores ??= await loadStores();
    noteRead(written);
    applyToStores(stores, written.settings);
    setStatus({ phase: 'synced', detail: null });
    return { ok: problems.length === 0, problems };
  } catch (err) {
    return { ok: false, problems: [err instanceof Error ? err.message : 'Could not write the file.'] };
  }
}

/** Current document as pretty JSON, for the raw editor. */
export function currentUiSettingsText(): string {
  return `${JSON.stringify(lastFile ?? defaultUiSettings(), null, 2)}\n`;
}

/** Test hook: forget all module state. */
export function resetUiSettingsSyncForTest(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  for (const u of unsubscribers) u();
  unsubscribers = [];
  stores = null;
  lastFile = null;
  started = false;
  status = { phase: 'idle', path: null, exists: false, problems: [], detail: null };
}
