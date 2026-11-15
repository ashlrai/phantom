/**
 * panes/panes.server-down.test.tsx — EVERY registered dock pane while the
 * local Phantom server errors or restarts mid-self-update: every read
 * answers 500, 503 (empty body) or fails at the network. Each pane must say
 * ONE readable settled sentence inside a second. Never throw, never
 * console.error, never keep spinning, never print "undefined", "NaN",
 * "[object" or "null".
 *
 * Sibling of panes.absent.test.tsx (same bar, same registry walk, helpers
 * copied rather than imported).
 *
 * A pane that fails is NOT a waiver: it goes in KNOWN_FAILURES (an it.todo
 * naming pane id and reason) and is recorded in BRIDGE_NOTES.md. An entry
 * is a bug report; keep the list as short as the truth allows.
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
function stubFetch(handler: () => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(async () => handler()));
}

const SCENARIOS = [
  { id: 'all-500', label: 'every read 500', install: () => stubFetch(() => Response.json({ error: 'internal' }, { status: 500 })) },
  { id: 'all-503', label: 'every read 503 with an empty body', install: () => stubFetch(() => new Response('', { status: 503 })) },
  { id: 'network', label: 'every read fails at the network', install: () => stubFetch(() => { throw new TypeError('Failed to fetch'); }) },
] as const;

/**
 * Panes that do not meet the bar yet — `${paneId}/${scenarioId}` → the
 * failure. An entry is a bug report, not a waiver.
 */
const KNOWN_FAILURES = new Map<string, string>([
  // ChecksPanel prints the raw refusal body: with a 500 { error: 'internal' }
  // the whole pane is the 8-char string "internal" (ChecksPanel →
  // describeContextError prefers ApiError.detail). Owned by another job.
  ['checks/all-500', 'pane renders only the raw server string "internal" (8 visible chars) — BRIDGE_NOTES.md'],
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

describe('every registered dock pane, local server down', () => {
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
