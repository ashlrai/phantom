/**
 * panes/panes.absent.test.tsx — EVERY registered dock pane, on a Mac with
 * no fleet (a fresh 3.30.0 install has no ~/.ashlr-runs): when each read
 * 404s — or /api/verse/fleet/runs answers with every source 'missing' —
 * the pane must say ONE readable sentence inside a second. Never throw,
 * never console.error, never keep spinning, never print "undefined",
 * "NaN", "[object" or "null".
 *
 * every-pane-sweep.test.tsx asks only for non-empty text per discovered
 * `*.pane.tsx` module; this file pins the honesty bar on the REGISTRY
 * (listPanes() — first-party stubs included, so a pane added later is
 * covered without being named here), under both absence shapes, with the
 * settled-state check the sweep lacks.
 *
 * A pane that fails is NOT edited here: it goes in KNOWN_FAILURES (an
 * it.todo naming pane id and reason) and is recorded in BRIDGE_NOTES.md,
 * so the suite stays green and the list stays visible.
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { evictAll } from '../../../data/cache.js';
import { resetDockStore } from '../dock/dock-store.js';
import { session } from '../fixtures.test-support.js';
import './index.js';
import { listPanes, type LazyPaneComponent, type PaneProps, type RegisteredPane } from './pane-registry.js';

const PANES: readonly RegisteredPane[] = listPanes();
const MIN_SENTENCE_CHARS = 12;
const BAD_CONTENT = ['undefined', 'NaN', '[object', 'null'] as const;
/** The repo's in-flight markers: Skeleton* primitives, surface skeletons, busy containers, spinners. */
const LOADING_MARKERS = '.skeleton, [data-skeleton], [aria-busy="true"], [role="progressbar"]';
/** Loading captions end in an ellipsis ("Reading live runs…", "Loading…"); a settled sentence does not. */
const LOADING_CAPTION = /\b(reading|loading|fetching|connecting|reconnecting|opening)\b[^\n]*?(?:…|\.{3})/i;

const chat = session();
const host: PaneProps['host'] = {
  sendToChat: vi.fn(), addToMessage: vi.fn(), openPane: vi.fn(), closePane: vi.fn(),
  openTerminal: vi.fn(), openTerminalBelow: vi.fn(), openDiff: vi.fn(), openSession: vi.fn(),
};

function paneProps(paneId: string): PaneProps {
  return {
    paneId, sessionId: chat.id, session: chat, roots: ['/project'], events: [], turnFiles: [],
    visible: true, presentation: 'column', requests: { terminal: null, preview: null, diff: null }, host,
  };
}

/** Every source reports 'missing': valid shape, empty fleet — the day-one Mac. */
const MISSING_RUNS: FleetRunsV1 = {
  v: 1,
  generatedAt: '2026-10-31T00:00:00.000Z',
  sources: { runsDir: 'missing', workers: 'missing', inbox: 'missing', codex: 'missing', merges: 'missing' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [],
  mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

const notFound = () => Response.json({ error: 'not found' }, { status: 404 });

function stubFetch(handler: (path: string) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(new URL(raw, 'http://localhost').pathname);
  }));
}

const SCENARIOS = [
  { id: 'all-404', label: 'every read 404', install: () => stubFetch(() => notFound()) },
  {
    id: 'missing-runs-dir',
    label: 'fleet/runs present, every source missing, all other reads 404',
    install: () => stubFetch((path) => (path === '/api/verse/fleet/runs' ? Response.json(MISSING_RUNS) : notFound())),
  },
] as const;

/**
 * Panes that do not meet the bar yet — `${paneId}/${scenarioId}` → the
 * failure, restated in the it.todo name and in BRIDGE_NOTES.md. Keep
 * EMPTY whenever every pane is honest; an entry is a bug report, not a
 * waiver.
 */
const KNOWN_FAILURES = new Map<string, string>([
  // ChecksPanel prints the raw refusal body: the whole pane is the 9-char
  // string "not found" (ChecksDockPane → ChecksPanel → describeContextError
  // prefers ApiError.detail, which is the gate's bare { error: 'not found' }).
  ['checks/all-404', 'pane renders only the raw server string "not found" (9 visible chars) — BRIDGE_NOTES.md'],
  ['checks/missing-runs-dir', 'pane renders only the raw server string "not found" (9 visible chars) — BRIDGE_NOTES.md'],
  // FleetBriefPane interpolates mergesLastHour.count verbatim, printing the
  // literal "null" in "Merged last hour: null" when the runs payload reports
  // null (its honest missing-fleet shape).
  ['fleet-brief/missing-runs-dir', 'shows literal "null" in "Merged last hour: null" — BRIDGE_NOTES.md'],
]);

/** Visible text, skipping anything hidden by attribute or computed style (every-pane-sweep's measure). */
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

beforeAll(async () => {
  // Load every lazy chunk once (module load is the slow part; mounts are cheap).
  await Promise.allSettled(PANES.map((pane) => (pane.component as Partial<LazyPaneComponent>).preload?.()));
}, 120_000);

beforeEach(() => { localStorage.clear(); resetDockStore(); evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); evictAll(); });

describe('every registered dock pane, absent fleet', () => {
  it('discovers the registry itself (all panes covered, no duplicates)', () => {
    expect(PANES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(PANES.map((pane) => pane.id)).size).toBe(PANES.length);
  });

  for (const pane of PANES) {
    for (const scenario of SCENARIOS) {
      const known = KNOWN_FAILURES.get(`${pane.id}/${scenario.id}`);
      const name = `"${pane.id}" stays honest with ${scenario.label}`;
      if (known !== undefined) {
        it.todo(`${name} — ${known}`);
        continue;
      }
      it(name, async () => {
        vi.useFakeTimers();
        const consoleError = vi.spyOn(console, 'error');
        scenario.install();
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown) => { rejections.push(reason); };
        process.on('unhandledRejection', onRejection);
        try {
          const Body = pane.component;
          const view = render(<Body {...paneProps(pane.id)} />);
          await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
          // Settled: no skeleton, spinner or busy region may still be up.
          expect(view.container.querySelector(LOADING_MARKERS), `${pane.id} still shows a skeleton or spinner`).toBeNull();
          const text = visibleText(view.container).trim();
          expect(text.length, `${pane.id} showed: ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(MIN_SENTENCE_CHARS);
          for (const bad of BAD_CONTENT) expect(text, `${pane.id} shows "${bad}"`).not.toContain(bad);
          expect(text, `${pane.id} still mid-read: ${JSON.stringify(text)}`).not.toMatch(LOADING_CAPTION);
          expect(rejections, `${pane.id} leaked a rejected promise`).toEqual([]);
          expect(consoleError, `${pane.id} logged console.error`).not.toHaveBeenCalled();
        } finally {
          process.off('unhandledRejection', onRejection);
        }
      }, 15_000);
    }
  }
});
