import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockState } from '../src/web-ui/routes/verse/shell/dock-catalog.js';
import type { VerseUiState } from '../src/web-ui/routes/verse/verse-ui-store.js';

// RQ-PHX-UISTOREOLDSTATE82 — a 3.30.x console opens on UI state persisted by
// 3.29.15 (Mason's installed build). `PersistedV3` is field-for-field identical
// across the two under the same `ashlr.verse.ui.v3` key, so this pins the load
// path's tolerance: removed section ids migrate, unknown pane ids drop or hold
// for late registration, out-of-range numbers clamp, non-JSON/wrong-type
// values fall back field by field — never a crash, never a blank surface.

const UI_KEY = 'ashlr.verse.ui.v3';
const FIXTURE_DIR = resolve(process.cwd(), 'test/fixtures/verse-ui-store');
const readFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf8')) as Record<string, unknown>;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  };
}

// Fixtures map storage key → value. Non-strings are stored as JSON; strings go
// in verbatim — how a fixture carries a non-JSON blob.
function seed(storage: Storage, fixture: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fixture)) {
    storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

/** Fresh module graph + `init()` — the real cold-launch load path. */
async function boot() {
  const ui = await import('../src/web-ui/routes/verse/verse-ui-store.js');
  const dock = await import('../src/web-ui/routes/verse/dock/dock-store.js');
  return { ui, dock };
}

function savedBlob(storage: Storage): Record<string, unknown> {
  const raw = storage.getItem(UI_KEY);
  expect(raw).toBeTruthy();
  return JSON.parse(raw!) as Record<string, unknown>;
}

const VALID_SECTIONS = new Set([
  'command', 'fleet', 'growth', 'mind', 'chat', 'agents',
  'settings', 'apps', 'usage', 'wiki', 'playbooks', 'automations', 'ops', 'live',
]);

function expectValidState(state: VerseUiState): void {
  expect(VALID_SECTIONS.has(state.section)).toBe(true);
  expect(state.mounted).toEqual([state.section]);
  expect(state.history.entries[0]).toEqual({ section: state.section, sessionId: null });
  expect(state.sidebarWidth).toBeGreaterThanOrEqual(240);
  expect(state.sidebarWidth).toBeLessThanOrEqual(360);
  expect(state.resourcesWidth).toBeGreaterThanOrEqual(260);
  expect(state.resourcesWidth).toBeLessThanOrEqual(480);
  expect(state.overlay).toBeNull();
}

function expectValidDock(dock: DockState): void {
  for (const id of dock.tabs) expect(id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
  expect(dock.active === null || dock.tabs.includes(dock.active)).toBe(true);
  expect(dock.splitWith === null || (dock.tabs.includes(dock.splitWith) && dock.splitWith !== dock.active)).toBe(true);
  expect(dock.width).toBeGreaterThanOrEqual(320);
  expect(dock.height).toBeGreaterThanOrEqual(160);
  expect(dock.splitRatio).toBeGreaterThanOrEqual(0.2);
  expect(dock.splitRatio).toBeLessThanOrEqual(0.8);
  expect(['right', 'bottom']).toContain(dock.placement);
}

let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('3.29.15 persisted state loads through the real hydrate path', () => {
  it('valid fixture: every field survives, legacy pane ids map, the blob is rewritten as v3', async () => {
    seed(storage, readFixture('v3-29-15.json'));
    const { ui, dock } = await boot();

    const state = ui.loadVerseUi();
    expectValidState(state);
    expect(state).toMatchObject({
      section: 'chat',
      railExpanded: true,
      sidebarWidth: 300,
      sidebarCollapsed: false,
      resourcesOpen: false,
      resourcesWidth: 352,
      recentChats: ['chat-1', 'chat-2'],
    });
    // `pane.preview` is the pre-rename pane action: mapped, not dropped.
    expect(state.recentActions).toEqual(['dock.preview', 'pane.browser', 'chat.new']);
    expectValidDock(dock.getDockState());
    expect(dock.getDockState()).toMatchObject({
      open: true,
      width: 460,
      tabs: ['browser', 'terminal', 'fleet-lanes', 'gone-pane'],
      active: 'browser',
      splitWith: 'terminal',
      placement: 'right',
      height: 320,
    });
    // Shape-valid ids the pane registry does not know yet are kept for late
    // registration; the legacy `preview` name resolved to `browser`.
    expect(dock.getDockState().byChat['chat-2']).toEqual({ open: true, tabs: ['browser', 'files'], active: 'files', splitWith: null });
    const saved = savedBlob(storage);
    expect(saved).toMatchObject({ version: 3, section: 'chat', sidebarWidth: 300 });
    expect(saved['dock']).toMatchObject({ tabs: ['browser', 'terminal', 'fleet-lanes', 'gone-pane'], active: 'browser' });
  });

  it('corrupt fixture: wrong types reset per-field, removed ids migrate, garbage drops', async () => {
    seed(storage, readFixture('v3-29-15-corrupt.json'));
    const { ui, dock } = await boot();

    const state = ui.loadVerseUi();
    expectValidState(state);
    expect(state).toMatchObject({
      // 'autonomy' is a removed section id: nearest current section, not a blank.
      section: 'fleet',
      railExpanded: false,
      sidebarWidth: 360,
      sidebarCollapsed: false,
      resourcesOpen: true,
      resourcesWidth: 320,
      recentActions: ['pane.browser', 'pane.context'],
      recentChats: ['chat-1', 'chat-9'],
    });
    // A v3 blob with a migrated section must NOT pop the v2 Needs-you overlay.
    expect(state.announceChatMoved).toBe(false);
    expectValidDock(dock.getDockState());
    expect(dock.getDockState()).toEqual({
      open: false,
      width: 440,
      tabs: ['browser'],
      active: 'browser',
      splitWith: null,
      splitRatio: 0.8,
      placement: 'right',
      height: 300,
      byChat: {
        'chat-9': { open: false, tabs: [], active: null, splitWith: null },
        'chat-8': { open: true, tabs: ['terminal'], active: 'terminal', splitWith: null },
      },
    });
    const saved = savedBlob(storage);
    expect(saved).toMatchObject({ version: 3, section: 'fleet' });
    expect((saved['dock'] as Record<string, unknown>)['tabs']).toEqual(['browser']);
  });
});

describe('missing storage', () => {
  it('no keys at all opens on the default surface', async () => {
    const { ui } = await boot();
    const state = ui.loadVerseUi();
    expectValidState(state);
    expect(state.section).toBe('live');
    expect(savedBlob(storage)).toMatchObject({ version: 3, section: 'live' });
  });

  it('a storage API that throws still boots to defaults', async () => {
    const denied = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied });
    const { ui, dock } = await boot();
    expectValidState(ui.loadVerseUi());
    expect(ui.loadVerseUi().section).toBe('live');
    expectValidDock(dock.getDockState());
  });

  it.each([['{not json at all'], ['42'], ['"chat"'], ['[1,2]']])('unreadable v3 value %j falls back to defaults', async (raw) => {
    storage.setItem(UI_KEY, raw);
    const { ui } = await boot();
    expect(ui.loadVerseUi().section).toBe('live');
    expect(savedBlob(storage)).toMatchObject({ version: 3, section: 'live' });
  });
});

describe('section id rejection', () => {
  it.each([['quantum'], [''], ['CHAT'], [42], [null], [['chat']]])(
    'unrecognised section %j opens the default surface',
    async (from) => {
      storage.setItem(UI_KEY, JSON.stringify({ version: 3, section: from }));
      const { ui } = await boot();
      expect(ui.loadVerseUi().section).toBe('live');
    },
  );
});

describe('future and foreign blobs', () => {
  it('a v4 blob under the v3 key is read field by field, never a crash', async () => {
    storage.setItem(
      UI_KEY,
      JSON.stringify({
        version: 4,
        section: 'fleet',
        railExpanded: true,
        sidebarWidth: 280,
        newFutureField: { nested: [1, 2, 3] },
      }),
    );
    const { ui } = await boot();
    const state = ui.loadVerseUi();
    expectValidState(state);
    expect(state).toMatchObject({ section: 'fleet', railExpanded: true, sidebarWidth: 280 });
    // The next write is a clean v3 blob; unknown future fields do not survive.
    expect(savedBlob(storage)).toMatchObject({ version: 3, section: 'fleet', sidebarWidth: 280 });
  });

  it('an unknown future storage key is ignored, not a crash', async () => {
    storage.setItem('ashlr.verse.ui.v4', JSON.stringify({ section: 'mind' }));
    const { ui } = await boot();
    expect(ui.loadVerseUi().section).toBe('live');
    expect(savedBlob(storage)).toMatchObject({ version: 3, section: 'live' });
  });
});
