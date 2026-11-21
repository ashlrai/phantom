/**
 * The fleet views on a 390 px phone: every view in the More list opens to a
 * screen that mounts, shows its heading, has no fixed width wider than the
 * screen and says "unknown" or an empty-state sentence in plain words.
 * (jsdom has no layout, so widths are read from inline styles, SVG attributes
 * and the stylesheets the screens use.)
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { FLEET_VIEWS } from './fleet-views.js';
import { formatMobileHash, parseMobileHash } from './mobile-router.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';
import { HeldScreen, LibraryScreen, MessageGraphScreen, PoolRunwayScreen, SpendScreen } from './screens/FleetViewScreens.js';
import { MoreScreen } from './screens/MoreScreen.js';

const PHONE = 390;
const NOW = new Date().toISOString();

const spend = { schema: 'usage.spend.v1', v: 1, asOf: NOW, headline: 'Claude will leave the most unused.', pools: [{
  pool: 'claude', unit: 'percent', reason: null, usedPercent: 40, resetAt: null, hoursLeft: null, burnPerHour: null,
  projectedUnusedPercent: null, projectedUsedPercent: null, remainingUsd: null, projectedUnusedUsd: null,
  verdict: 'unknown', status: 'unknown', summary: 'unknown', resetsIn: null,
}] };
const runway = { schema: 'pool.runway.v1', v: 1, asOf: NOW, headline: 'One pool read.', pools: [{ pool: 'claude', state: 'unknown', advice: 'unknown', usedPercent: null }] };
const graph = { schema: 'fleet.message-graph.v1', version: 1, generatedAt: NOW, since: NOW, source: 'bus', organizations: [], messages: 3, skipped: 0, groups: [
  { id: 'g1', from: 'Anthropic', to: 'OpenAI', count: 3, lastAt: NOW, edges: [{ id: 'e1', from: 'worker one', to: 'worker two', count: 3, lastAt: NOW }] },
] };
const held = [{ job_or_lane: 'zai', kind: 'idle_lane', reason: 'Lane is held with work queued.', since: NOW, unblock: 'Lift the hold.' }];
const library = { v: 1, asOf: NOW, unavailable: [], items: [{ id: 'memory:0123456789abcdef', kind: 'memory', title: 'Plain note', source: 'memory', asOf: NOW, preview: 'Short words.', owner: null, size: null }] };

const VIEWS: ReadonlyArray<{ name: string; heading: string; node: () => React.ReactNode; routes: Record<string, unknown>; ready: RegExp | string }> = [
  { name: 'Spend down', heading: 'Spend down', node: () => <SpendScreen />, routes: { 'GET /api/usage/spend': spend }, ready: /Claude will leave/ },
  { name: 'Pool runway', heading: 'Pool runway', node: () => <PoolRunwayScreen />, routes: { 'GET /api/usage/runway': runway }, ready: /usage unknown/ },
  { name: 'Held work', heading: 'Held work', node: () => <HeldScreen />, routes: { 'GET /api/verse/fleet/runs': { ...fleetRunsFixture(), notRunning: held } }, ready: /Next: Lift the hold/ },
  { name: 'Library', heading: 'Library', node: () => <LibraryScreen />, routes: { 'GET /api/verse/fleet/library-files/items': library }, ready: 'Library overview' },
  { name: 'Message graph', heading: 'Message graph', node: () => <MessageGraphScreen />, routes: { 'GET /api/fleet/message-graph': graph }, ready: /Anthropic to OpenAI/ },
];

const SHEETS = ['FleetViewScreens.module.css', '../library/library.module.css', '../resources/SpendDown.module.css', '../resources/UsageHistoryChart.module.css', '../home/home.module.css'];

let viewport: ViewportMock;
beforeEach(() => { viewport = mockViewport(PHONE); });
afterEach(() => { viewport.restore(); evictAll(); vi.unstubAllGlobals(); });

describe('phone navigation', () => {
  it('lists every fleet view by its plain name and opens each', () => {
    const { context } = renderMobile(<MoreScreen />);
    const list = screen.getByRole('region', { name: 'Fleet views' });
    expect(FLEET_VIEWS.map((v) => v.title)).toEqual(['Goals', 'Spend down', 'Pool runway', 'Held work', 'Library', 'Message graph']);
    for (const view of FLEET_VIEWS) {
      fireEvent.click(within(list).getByRole('button', { name: new RegExp(`^${view.title}`) }));
      expect(context.navigate).toHaveBeenLastCalledWith({ screen: view.screen });
      expect(parseMobileHash(formatMobileHash({ screen: view.screen }))).toEqual({ screen: view.screen });
    }
  });
});

describe.each(VIEWS)('$name at 390 px', ({ heading, node, routes, ready }) => {
  it('mounts, shows its heading, and fits the screen', async () => {
    stubFetch(routes);
    const { container } = renderMobile(node());
    expect(screen.getAllByRole('heading', { name: heading }).length).toBeGreaterThan(0);
    await waitFor(() => expect(typeof ready === 'string' ? screen.getByLabelText(ready) : screen.getAllByText(ready)[0]).toBeInTheDocument());
    for (const el of container.querySelectorAll<HTMLElement>('[style]')) {
      for (const prop of ['width', 'minWidth', 'flexBasis'] as const) {
        const px = /^(\d+(?:\.\d+)?)px$/.exec(el.style[prop]);
        if (px) expect(Number(px[1]), `${prop} on <${el.tagName.toLowerCase()}>`).toBeLessThanOrEqual(PHONE);
      }
    }
    for (const svg of container.querySelectorAll('svg[width]')) expect(Number(svg.getAttribute('width'))).toBeLessThanOrEqual(PHONE);
  });
});

describe('unknown and empty, in plain words', () => {
  it('Held work says unknown when the Mac does not report it, and empty when nothing is held', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': fleetRunsFixture() });
    const { unmount } = renderMobile(<HeldScreen />);
    expect(await screen.findByText('Held work is unknown.')).toBeInTheDocument();
    unmount(); evictAll();
    stubFetch({ 'GET /api/verse/fleet/runs': { ...fleetRunsFixture(), notRunning: [] } });
    renderMobile(<HeldScreen />);
    expect(await screen.findByText('Nothing is held.')).toBeInTheDocument();
  });

  it('Message graph says its counts are unknown, not zero, when the read fails', async () => {
    stubFetch({});
    renderMobile(<MessageGraphScreen />);
    expect(await screen.findByText(/unknown, not zero/)).toBeInTheDocument();
  });

  it('Message graph with no groups says so', async () => {
    stubFetch({ 'GET /api/fleet/message-graph': { ...graph, groups: [], messages: 0 } });
    renderMobile(<MessageGraphScreen />);
    expect(await screen.findByText('No messages yet.')).toBeInTheDocument();
  });
});

describe('stylesheets the views use', () => {
  it('declare no pixel width wider than the screen', () => {
    for (const sheet of SHEETS) {
      const css = readFileSync(resolve(__dirname, sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/(?:^|[;{\s])(width|min-width|flex-basis)\s*:\s*([^;}]+)/g)) {
        for (const px of m[2]!.matchAll(/(\d+(?:\.\d+)?)px/g)) expect(Number(px[1]), `${sheet} ${m[1]}: ${m[2]}`).toBeLessThanOrEqual(PHONE);
      }
    }
  });
});
