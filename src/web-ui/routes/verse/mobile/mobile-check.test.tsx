/** Fixture views for the measuring half of `phm mobile check`: a clean view, one too wide, one with a small tap target, small text and sizes nobody stated. */
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { buildMobileCheck, mobileCheckText, type MobileViewCheck } from '../../../../core/mobile/check.js';
import { checkView, parseCss, type Sheets } from './mobile-check.test-support.js';

const CSS = `
  .page { font-size: 14px; }
  .big { min-height: 2.75rem; }
  .small { height: 28px; }
  .padded { padding: 4px 8px; line-height: 18px; }
  .wide { width: 600px; }
  .scroller { overflow-x: auto; }
  .columns { display: grid; grid-template-columns: 200px 200px 1fr; }
  .line { white-space: nowrap; }
  .clipped { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tiny { font-size: 0.75em; }
  .odd { font-size: clamp(1em, 2vw, 2em); }
  @media (min-width: 600px) { .big { min-height: 20px; } }
  @media (max-width: 479.98px) { .phone { min-height: 44px; } }
`;
const sheets: Sheets = new Map([['', parseCss(CSS)]]);
const LONG = 'one long line of plain words that goes on and on well past the edge of a phone screen';
const check = (body: React.ReactNode) => checkView('fixture', 'Fixture', render(<div className="page">{body}</div>).container, sheets);

it('a clean view has no findings and nothing unknown', () => {
  const view = check(<><p>Plain words.</p><button className="big">Go</button><button className="small phone">Phone</button>
    <div className="scroller"><div className="wide">A wide table that scrolls inside its own box.</div></div><p className="clipped">{LONG}</p></>);
  expect(view).toEqual({ id: 'fixture', title: 'Fixture', rendered: true, overflow: 0, smallTaps: 0, smallText: 0, unknown: 0, findings: [] });
});

it('an overflowing view: a fixed width, fixed grid columns and an unbroken line are each reported', () => {
  const view = check(<><div className="wide">Wide</div><div className="columns"><span>a</span></div><p className="line">{LONG}</p></>);
  expect(view.overflow).toBe(3);
  expect(view.findings.map(finding => [finding.kind, finding.detail])).toEqual([
    ['overflow', 'width 600px'], ['overflow', 'grid columns add up to 400px'], ['overflow', `one unbroken line of ${LONG.length} characters`]]);
});

it('a small tap target: a stated height and one worked out from padding are reported; a link in a sentence is not', () => {
  const view = check(<><button className="small" aria-label="Close">x</button><button className="padded">Retry</button><p>Read <a href="#more">more</a>.</p></>);
  expect(view.findings).toEqual([
    { kind: 'tap', element: 'button "Close"', detail: '28px tall' },
    { kind: 'tap', element: 'button "Retry"', detail: 'about 26px tall' }]);
  expect([view.smallTaps, view.overflow, view.smallText, view.unknown]).toEqual([2, 0, 0, 0]);
});

it('small text is reported, and a size no rule states is unknown rather than a pass or a failure', () => {
  const view = check(<><span className="tiny">Fine print</span><span className="odd">Fluid</span><button>Bare</button></>);
  expect(view.findings).toEqual([{ kind: 'text', element: 'span "Fine print"', detail: '10.5px' }]);
  expect(view.unknown).toBe(2);
});

it('the report keeps a stable shape, worst view first', () => {
  const report = buildMobileCheck([check(<p>Fine.</p>), { ...check(<button className="small">x</button>), id: 'worse' }]);
  expect(Object.keys(report)).toEqual(['schema', 'version', 'widthPx', 'minTapPx', 'minTextPx', 'state', 'note', 'views', 'totals']);
  expect(report).toMatchObject({ schema: 'mobile.check.v1', version: 1, widthPx: 390, minTapPx: 44, minTextPx: 12, state: 'ok',
    totals: { views: 2, failing: 1, overflow: 0, smallTaps: 1, smallText: 0, unknown: 0 } });
  expect(report.views.map(view => view.id)).toEqual(['worse', 'fixture']);
});

it('unknown measurements are excluded from pass counts', () => {
  const unknown: MobileViewCheck = { id: 'unknown', title: 'Unknown', rendered: true, overflow: 0, smallTaps: 0, smallText: 0, unknown: 1, findings: [] };
  const onlyUnknown = buildMobileCheck([unknown]);
  expect(onlyUnknown.totals).toMatchObject({ views: 1, failing: 0, unknown: 1 });
  expect(mobileCheckText(onlyUnknown)[0]).toBe('Mobile check at 390 px: 0 of 1 pass, 1 unknown.');

  const mixed = buildMobileCheck([{ ...unknown, id: 'clean', unknown: 0 }, unknown]);
  expect(mobileCheckText(mixed)[0]).toBe('Mobile check at 390 px: 1 of 2 pass, 1 unknown.');

  const allPass = buildMobileCheck([{ ...unknown, id: 'clean', unknown: 0 }]);
  expect(mobileCheckText(allPass)[0]).toBe('Mobile check at 390 px: 1 of 1 pass.');
});
