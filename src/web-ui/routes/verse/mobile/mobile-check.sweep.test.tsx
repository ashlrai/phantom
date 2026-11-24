/**
 * The sweep `phm mobile check` runs: every registered desktop view (first-party
 * panes and every discovered `*.pane.tsx`), rendered 390 px wide against an
 * empty Mac (or, for a view that cannot draw an empty answer, a Mac that
 * answers 404), measured by mobile-check.test-support.ts. With
 * PHM_MOBILE_CHECK_OUT set it writes the mobile.check.v1 report there. In the
 * normal suite it holds the views already fixed for a phone at zero findings.
 */
import { act, cleanup, render } from '@testing-library/react';
import { writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { buildMobileCheck, MOBILE_CHECK_OUT_ENV, MOBILE_WIDTH_PX, type MobileViewCheck } from '../../../../core/mobile/check.js';
import { evictAll } from '../../../data/cache.js';
import { session } from '../fixtures.test-support.js';
import { paneProps } from '../panes/pane-fixtures.test-support.js';
import { mockViewport } from '../shell/viewport.test-support.js';
import { checkView } from './mobile-check.test-support.js';

/** Views that pass at 390 px. Add a view here when you fix it; never remove one to go green. */
const PHONE_READY = ['browser', 'company', 'context', 'home', 'library'];

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('measures every registered desktop view at 390 px', async () => {
  const viewport = mockViewport(MOBILE_WIDTH_PX);
  const { listPanes } = await import('../panes/index.js');
  const chat = session();
  const views: MobileViewCheck[] = [];
  for (const pane of listPanes()) {
    const Body = pane.component as typeof pane.component & { preload?: () => Promise<unknown> };
    let check: MobileViewCheck = { id: pane.id, title: pane.title, rendered: false, overflow: 0, smallTaps: 0, smallText: 0, unknown: 0, findings: [] };
    for (const status of [200, 404]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status })));
      try {
        await Body.preload?.();
        const view = render(<div style={{ width: MOBILE_WIDTH_PX }}><Body {...paneProps({ paneId: pane.id, sessionId: chat.id, session: chat, roots: ['/project'], presentation: 'bottom-sheet' })} /></div>);
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
        check = checkView(pane.id, pane.title, view.container);
      } catch { /* stays unrendered unless the next answer draws */ }
      cleanup();
      evictAll();
      if (check.rendered) break;
    }
    views.push(check);
  }
  viewport.restore();
  const report = buildMobileCheck(views);
  const out = process.env[MOBILE_CHECK_OUT_ENV];
  if (out) writeFileSync(out, JSON.stringify(report));
  expect(report.totals!.views).toBeGreaterThanOrEqual(50);
  expect(report.views.filter(view => !view.rendered).map(view => view.id)).toEqual([]);
  expect(report.views.filter(view => PHONE_READY.includes(view.id)).map(view => [view.id, view.findings]).sort()).toEqual(PHONE_READY.map(id => [id, []]));
}, 600_000);
