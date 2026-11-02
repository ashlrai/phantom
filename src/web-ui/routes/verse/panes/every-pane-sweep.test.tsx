import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { session } from '../fixtures.test-support.js';
import { getDockState, openDockPane, resetDockStore } from '../dock/dock-store.js';
import * as registry from './pane-registry.js';
import type { PaneDefinition, PaneProps } from './pane-registry.js';

const modules = import.meta.glob('../**/*.pane.tsx');
const registrations = new Map<string, PaneDefinition[]>();
const host: PaneProps['host'] = {
  sendToChat: vi.fn(), addToMessage: vi.fn(), openPane: vi.fn(), closePane: vi.fn(),
  openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn(),
};
const emptyRuns = {
  v: 1, generatedAt: '2026-01-01T00:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [],
  mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
function emptyPayload(url: string): unknown {
  if (url.includes('/fleet/runs') && !url.includes('/inbox')) return emptyRuns;
  if (url.includes('/fleet/live/bus')) return { v: 1, hops: [], hopsDropped: 0, lastHopAt: null, events: [], sources: { hops: 'healthy', events: 'healthy' } };
  if (url.includes('/ops/leader-journal')) return { v: 1, generatedAt: '2026-01-01T00:00:00Z', sources: { planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' }, passes: [], ingest: [], ingested: [], rejectedLastHour: 0 };
  if (url.includes('/ops/releases')) return { v: 1, generatedAt: '2026-01-01T00:00:00Z', sourceState: 'healthy', repos: [] };
  return {};
}
function visibleText(container: HTMLElement): string {
  return Array.from(container.querySelectorAll('*'))
    .filter((element) => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true'
          || style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    })
    .flatMap((element) => Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE))
    .map((node) => node.textContent?.trim()).join('');
}
const chat = session();
const context = { sessionId: chat.id, session: chat, roots: ['/project'], events: [], turnFiles: [], host };
let Dock: typeof import('../dock/Dock.js').Dock;

beforeAll(async () => {
  const spy = vi.spyOn(registry, 'registerPane');
  for (const [path, load] of Object.entries(modules)) {
    spy.mockClear();
    await load();
    registrations.set(path, spy.mock.calls.map(([definition]) => definition));
  }
  spy.mockRestore();
  ({ Dock } = await import('../dock/Dock.js'));
}, 120_000);

beforeEach(() => { localStorage.clear(); resetDockStore(); evictAll(); });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

describe('all discovered panes together', () => {
  it('registers exactly one unique id per pane file', () => {
    expect(Object.keys(modules).length).toBeGreaterThanOrEqual(17);
    const errors = [...registrations].filter(([, definitions]) => definitions.length !== 1);
    expect(errors.map(([path, definitions]) => `${path}: ${definitions.length}`)).toEqual([]);
    const ids = [...registrations.values()].flat().map((definition) => definition.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    for (const id of ids) expect(registry.getPane(id), id).not.toBeNull();
  });

  it('offers every registered pane in the actual Dock menu', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    openDockPane('tasks');
    render(<Dock presentation="column" windowWidth={1440} columnWidth={440} pane={context} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a pane' }));
    const menu = screen.getByRole('menu', { name: 'Add a pane' });
    const unreachable = registry.listPanes().filter((pane) => !getDockState().tabs.includes(pane.id)
      && !within(menu).queryByRole('menuitem', { name: pane.title })).map((pane) => pane.id);
    expect(unreachable).toEqual([]);
    const first = registry.listPanes().find((pane) => !getDockState().tabs.includes(pane.id))!;
    fireEvent.click(within(menu).getByRole('menuitem', { name: first.title }));
    expect(getDockState().active).toBe(first.id);
  }, 120_000);

  it('mounts all discovered panes together against an empty fleet', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(emptyPayload(String(url)))));
    const panes = [...registrations.values()].flat().map((definition) => registry.getPane(definition.id)!);
    await Promise.all(panes.map((pane) => (pane.component as typeof pane.component & { preload?: () => Promise<unknown> }).preload?.()));
    const views = panes.map((pane) => {
      const Body = pane.component;
      return render(<Body {...context} paneId={pane.id} visible presentation="column" requests={{ terminal: null, preview: null, diff: null }} />);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    for (const [index, view] of views.entries()) expect(visibleText(view.container), panes[index]!.id).not.toBe('');
  }, 120_000);

  for (const [path] of Object.entries(modules)) {
    for (const state of ['error', 'empty', '404'] as const) {
      it(`${path} renders visible content with ${state} API`, async () => {
        const definition = registrations.get(path)?.[0];
        expect(definition, path).toBeDefined();
        const pane = registry.getPane(definition!.id)!;
        const component = pane.component as typeof pane.component & { preload?: () => Promise<unknown> };
        vi.stubGlobal('fetch', vi.fn(async (url: string) => state === 'empty'
          ? Response.json(emptyPayload(String(url))) : new Response(null, { status: state === '404' ? 404 : 500 })));
        await component.preload?.();
        const Body = component;
        const view = render(<Body {...context} paneId={pane.id} visible presentation="column" requests={{ terminal: null, preview: null, diff: null }} />);
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
        expect(visibleText(view.container), `${pane.id} ${state}`).not.toBe('');
      }, 30_000);
    }
  }
});
