/**
 * data/appearance-sync.ts — keep this console's appearance in step with the
 * server-side record (`<runs>/ui/appearance.json` via /api/verse/appearance),
 * so an agent's `ashlr fleet appearance set …` reaches a running app and the
 * operator's Settings changes are visible to `ashlr fleet appearance`.
 *
 * On start and every POLL_MS while the document is visible, GET the record;
 * a newer revision is applied through setAppearance() (which also persists it
 * to localStorage and applies the attributes live). When the operator changes
 * appearance locally, PUT the snapshot with the last known revision. On 409
 * the server wins: refetch and apply its copy — no loop, because the apply is
 * marked so our own subscription does not PUT it back.
 *
 * When the route is absent (404) or the server is offline, nothing happens and
 * localStorage behaviour is unchanged. The module stays out of the first-paint
 * closure: appearance-boot.ts loads it with a dynamic import, and it loads
 * appearance-store the same way, so the Settings-only store is not pulled into
 * the boot chunk either.
 */
import { getMutationToken, getReadClientProof } from './auth-store.js';

/** Same literal as core/verse/ui-appearance-api.ts VERSE_UI_APPEARANCE_PATH — kept textual: the core module is node-only. */
export const UI_APPEARANCE_API_PATH = '/api/verse/appearance';
export const UI_APPEARANCE_POLL_MS = 15_000;
/** sessionStorage key for the last server revision this tab applied. */
const REVISION_KEY = 'ashlr.verse.appearance.revision.v1';
const UPDATED_BY = 'verse-ui';

type AppearanceStore = typeof import('./appearance-store.js');
/** The stored shape: the web Appearance minus the derived reduceMotion. */
export interface ServerAppearanceBody {
  revision: number;
  appearance?: Partial<import('./appearance-store.js').Appearance> | null;
}

let store: AppearanceStore | null = null;
async function appearanceStore(): Promise<AppearanceStore> {
  return (store ??= await import('./appearance-store.js'));
}

let lastRevision = 0;
let applyingRemote = false;
let putting = false;
let dirty = false;
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;

function rememberRevision(revision: number): void {
  lastRevision = revision;
  try {
    sessionStorage.setItem(REVISION_KEY, String(revision));
  } catch {
    /* best-effort: memory still carries it */
  }
}

function readRemembered(): number {
  try {
    const raw = sessionStorage.getItem(REVISION_KEY);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function fetchServer(): Promise<ServerAppearanceBody | null> {
  try {
    const res = await fetch(UI_APPEARANCE_API_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'x-ashlr-read-client': getReadClientProof() },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ServerAppearanceBody;
    return typeof body?.revision === 'number' && Number.isFinite(body.revision) ? body : null;
  } catch {
    return null;
  }
}

async function poll(): Promise<void> {
  const server = await fetchServer();
  if (server === null) return;
  if (server.revision < lastRevision) rememberRevision(server.revision);
  if (server.revision > lastRevision && server.appearance) {
    const { setAppearance } = await appearanceStore();
    applyingRemote = true;
    try {
      setAppearance(server.appearance);
    } finally {
      applyingRemote = false;
    }
    rememberRevision(server.revision);
  }
}

/** The snapshot minus the derived reduceMotion — the shape the server stores. */
function storedShape(appearance: import('./appearance-store.js').Appearance): Record<string, unknown> {
  const { reduceMotion: _derived, ...rest } = appearance;
  return rest;
}

async function put(): Promise<void> {
  if (putting) return;
  putting = true;
  try {
    do {
      dirty = false;
      const token = getMutationToken();
      if (!token) return;
      const { getAppearance } = await appearanceStore();
      const res = await fetch(UI_APPEARANCE_API_PATH, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-ashlr-token': token },
        body: JSON.stringify({ expectedRevision: lastRevision, appearance: storedShape(getAppearance()), updatedBy: UPDATED_BY }),
      }).catch(() => null);
      if (res === null) return;
      if (res.status === 409) {
        // Server wins: refetch and apply its copy (guarded, so no PUT loop).
        await poll();
        return;
      }
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as ServerAppearanceBody | null;
        if (body && typeof body.revision === 'number') rememberRevision(body.revision);
      }
      // 401/404/…: token refused or route absent — localStorage keeps the value.
    } while (dirty);
  } finally {
    putting = false;
  }
}

function onLocalChange(): void {
  if (applyingRemote) return;
  dirty = true;
  void put();
}

/**
 * Start polling and mirroring. Idempotent; returns a stop function (tests).
 */
export function startAppearanceSync(): () => void {
  if (started || typeof document === 'undefined' || typeof fetch === 'undefined') return () => undefined;
  started = true;
  lastRevision = readRemembered();
  const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
  void poll();
  timer = setInterval(() => { if (visible()) void poll(); }, UI_APPEARANCE_POLL_MS);
  const onVisible = () => { if (visible()) void poll(); };
  document.addEventListener('visibilitychange', onVisible);
  void appearanceStore().then((s) => {
    if (!started || unsubscribe !== null) return;
    unsubscribe = s.subscribeAppearance(onLocalChange);
  });
  return () => {
    started = false;
    if (timer !== null) clearInterval(timer);
    timer = null;
    document.removeEventListener('visibilitychange', onVisible);
    unsubscribe?.();
    unsubscribe = null;
  };
}
