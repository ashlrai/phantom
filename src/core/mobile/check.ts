/**
 * mobile/check.ts: the report behind `phm mobile check`. Every registered
 * desktop view is rendered 390 px wide in the web UI's test renderer (the
 * sweep file below) and measured against its own stylesheets for three things
 * a phone cannot live with: content wider than the screen, tap targets under
 * 44 px and text under 12 px. The renderer has no layout engine, so sizes come
 * from the rules that apply to each element; a size no rule states is counted
 * as unknown, never as a pass or a failure.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MOBILE_CHECK_SCHEMA = 'mobile.check.v1';
export const MOBILE_WIDTH_PX = 390;
export const MIN_TAP_PX = 44;
export const MIN_TEXT_PX = 12;
/** Findings listed per view; the counts beside them are always complete. */
export const MAX_FINDINGS = 20;
export const MOBILE_SWEEP_TEST = 'src/web-ui/routes/verse/mobile/mobile-check.sweep.test.tsx';
/** Where the sweep writes its report when the CLI runs it. */
export const MOBILE_CHECK_OUT_ENV = 'PHM_MOBILE_CHECK_OUT';

export interface MobileFinding { kind: 'overflow' | 'tap' | 'text'; element: string; detail: string }
export interface MobileViewCheck {
  id: string;
  title: string;
  /** False when the view threw while rendering: nothing about it is known. */
  rendered: boolean;
  overflow: number;
  smallTaps: number;
  smallText: number;
  /** Tap targets and text whose size no stylesheet rule states. */
  unknown: number;
  findings: MobileFinding[];
}
export interface MobileCheckReport {
  schema: typeof MOBILE_CHECK_SCHEMA;
  version: 1;
  widthPx: number;
  minTapPx: number;
  minTextPx: number;
  /** `unknown`: the views could not be rendered here; `views` is empty and `totals` is null. */
  state: 'ok' | 'unknown';
  note: string | null;
  totals: { views: number; failing: number; overflow: number; smallTaps: number; smallText: number; unknown: number } | null;
  /** Worst first. */
  views: MobileViewCheck[];
}

const problems = (view: MobileViewCheck): number => view.overflow + view.smallTaps + view.smallText;
const failing = (view: MobileViewCheck): boolean => !view.rendered || problems(view) > 0;
const passing = (view: MobileViewCheck): boolean => view.rendered && problems(view) === 0 && view.unknown === 0;
const sum = (views: MobileViewCheck[], pick: (view: MobileViewCheck) => number): number => views.reduce((total, view) => total + pick(view), 0);

/** Pure: the same views always give the same report. A string instead of views is the reason nothing could be measured. */
export function buildMobileCheck(views: MobileViewCheck[] | string): MobileCheckReport {
  const base = { schema: MOBILE_CHECK_SCHEMA, version: 1, widthPx: MOBILE_WIDTH_PX, minTapPx: MIN_TAP_PX, minTextPx: MIN_TEXT_PX } as const;
  if (typeof views === 'string') return { ...base, state: 'unknown', note: views, totals: null, views: [] };
  const sorted = [...views].sort((a, b) => Number(a.rendered) - Number(b.rendered) || problems(b) - problems(a) || a.id.localeCompare(b.id));
  return { ...base, state: 'ok', note: null, views: sorted, totals: {
    views: sorted.length, failing: sorted.filter(failing).length, overflow: sum(sorted, view => view.overflow),
    smallTaps: sum(sorted, view => view.smallTaps), smallText: sum(sorted, view => view.smallText), unknown: sum(sorted, view => view.unknown),
  } };
}

export function mobileCheckText(report: MobileCheckReport): string[] {
  if (!report.totals) return [`Mobile check: unknown. ${report.note ?? 'The views could not be rendered.'}`];
  const { totals } = report;
  const unknown = totals.unknown > 0 ? `, ${totals.unknown} unknown` : '';
  return [
    `Mobile check at ${report.widthPx} px: ${report.views.filter(passing).length} of ${totals.views} pass${unknown}.`,
    `Wider than the screen: ${totals.overflow}. Tap targets under ${report.minTapPx} px: ${totals.smallTaps}. Text under ${report.minTextPx} px: ${totals.smallText}. Size unknown: ${totals.unknown}.`,
    ...report.views.filter(failing).map(view => view.rendered
      ? `  ${view.id}: ${view.overflow} too wide, ${view.smallTaps} small tap targets, ${view.smallText} small text${view.findings[0] ? ` (first: ${view.findings[0].element}, ${view.findings[0].detail})` : ''}`
      : `  ${view.id}: unknown, the view did not render`),
  ];
}

/** Runs the sweep in the web UI's test renderer. Needs a source checkout with its dev dependencies; anywhere else the report says unknown. */
export async function runMobileSweep(root: string): Promise<MobileCheckReport> {
  const vitest = join(root, 'node_modules/vitest/vitest.mjs');
  if (!existsSync(join(root, MOBILE_SWEEP_TEST)) || !existsSync(vitest)) return buildMobileCheck('Run this inside a Phantom source checkout after npm ci; an installed copy has no views to render.');
  const scratch = mkdtempSync(join(tmpdir(), 'phm-mobile-check-'));
  const out = join(scratch, 'report.json');
  try {
    // A scratch HOME keeps the run away from ~/.ashlr, like every other test run.
    await new Promise<void>(done => execFile(process.execPath, [vitest, 'run', '--config', 'vitest.config.web.ts', MOBILE_SWEEP_TEST],
      { cwd: root, env: { ...process.env, HOME: scratch, [MOBILE_CHECK_OUT_ENV]: out }, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 }, () => done()));
    const report = JSON.parse(readFileSync(out, 'utf8')) as MobileCheckReport;
    return report.schema === MOBILE_CHECK_SCHEMA ? report : buildMobileCheck('The sweep wrote a report this version cannot read.');
  } catch {
    return buildMobileCheck('The sweep did not finish, so no view was measured.');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
