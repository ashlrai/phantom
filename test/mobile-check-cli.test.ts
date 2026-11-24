/** `phm mobile check`: the report (mobile.check.v1) and the thin handler, on fixture views. The sweep itself is injected; nothing is rendered here. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdMobile } from '../src/cli/mobile.js';
import { buildMobileCheck, mobileCheckText, runMobileSweep, type MobileViewCheck } from '../src/core/mobile/check.js';

const view = (id: string, more: Partial<MobileViewCheck> = {}): MobileViewCheck => ({ id, title: id, rendered: true, overflow: 0, smallTaps: 0, smallText: 0, unknown: 0, findings: [], ...more });
const clean = view('clean');
const wide = view('wide', { overflow: 1, findings: [{ kind: 'overflow', element: 'div "Table"', detail: 'width 600px' }] });
const taps = view('taps', { smallTaps: 2, findings: [{ kind: 'tap', element: 'button "Close"', detail: '28px tall' }] });
const unknown = view('unknown', { unknown: 1 });

async function run(args: string[], views: MobileViewCheck[] | string = [clean, wide, taps]) {
  const out: string[] = [], err: string[] = [];
  const code = await cmdMobile(args, { out: line => out.push(line), err: line => err.push(line), root: '/fixture', run: async () => buildMobileCheck(views) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('phm mobile check', () => {
  it('--json prints a stable mobile.check.v1 report, worst view first, and exits 1 while a view fails', async () => {
    const result = await run(['check', '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({
      schema: 'mobile.check.v1', version: 1, widthPx: 390, minTapPx: 44, minTextPx: 12, state: 'ok', note: null,
      views: [taps, wide, clean], totals: { views: 3, failing: 2, overflow: 1, smallTaps: 2, smallText: 0, unknown: 0 },
    });
  });

  it('text names each failing view with its counts and first finding; clean views exit 0', async () => {
    const result = await run(['check']);
    expect(result.out.split('\n')).toEqual([
      'Mobile check at 390 px: 1 of 3 pass.',
      'Wider than the screen: 1. Tap targets under 44 px: 2. Text under 12 px: 0. Size unknown: 0.',
      '  taps: 0 too wide, 2 small tap targets, 0 small text (first: button "Close", 28px tall)',
      '  wide: 1 too wide, 0 small tap targets, 0 small text (first: div "Table", width 600px)',
    ]);
    expect((await run(['check'], [clean])).code).toBe(0);
  });

  it('unknown-only and mixed results do not count as passing and exit 3', async () => {
    const onlyUnknown = await run(['check', '--json'], [unknown]);
    expect(onlyUnknown.code).toBe(3);
    expect(JSON.parse(onlyUnknown.out)).toMatchObject({ state: 'ok', totals: { views: 1, failing: 0, unknown: 1 } });
    expect((await run(['check'], [unknown])).out.split('\n')[0])
      .toBe('Mobile check at 390 px: 0 of 1 pass, 1 unknown.');

    const mixed = await run(['check'], [clean, unknown]);
    expect(mixed.code).toBe(3);
    expect(mixed.out.split('\n')[0]).toBe('Mobile check at 390 px: 1 of 2 pass, 1 unknown.');
  });

  it('all passing views exit 0', async () => {
    const result = await run(['check'], [clean]);
    expect(result.code).toBe(0);
    expect(result.out.split('\n')[0]).toBe('Mobile check at 390 px: 1 of 1 pass.');
  });

  it('a view that did not render fails as unknown and sorts first', () => {
    const report = buildMobileCheck([wide, view('broken', { rendered: false })]);
    expect(report.views.map(entry => entry.id)).toEqual(['broken', 'wide']);
    expect(report.totals?.failing).toBe(2);
    expect(mobileCheckText(report)).toContain('  broken: unknown, the view did not render');
  });

  it('says unknown, with null totals and exit 3, when nothing could be rendered', async () => {
    const result = await run(['check', '--json'], 'No views here.');
    expect(result.code).toBe(3);
    expect(JSON.parse(result.out)).toMatchObject({ schema: 'mobile.check.v1', version: 1, state: 'unknown', note: 'No views here.', totals: null, views: [] });
    expect((await run(['check'], 'No views here.')).out).toBe('Mobile check: unknown. No views here.');
    // Outside a source checkout the real runner answers the same way, without running anything.
    const empty = mkdtempSync(join(tmpdir(), 'mobile-check-'));
    try { expect(await runMobileSweep(empty)).toMatchObject({ state: 'unknown', totals: null }); } finally { rmSync(empty, { recursive: true, force: true }); }
  });

  it('--help exits 0; any other verb or flag is a usage error', async () => {
    expect(await run(['--help'])).toMatchObject({ code: 0, err: '' });
    expect(await run(['check', '--wide'])).toMatchObject({ code: 2, out: '' });
    expect((await run([])).code).toBe(2);
    expect((await run(['fix'])).err).toContain('the only verb is check');
  });
});
