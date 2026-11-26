/**
 * core/verse/self-surface-agent.ts — the agent side of the self-surface: send
 * one request to the running console (endpoint.json), and the post-release
 * self-check that opens each main screen, captures it and flags console
 * errors, slow loads and layout regressions against a local baseline.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { SELF_REQUEST_PATH, SELF_TOKEN_HEADER, readSelfSurfaceEndpoint, type SelfResult } from './self-surface.js';

export interface SelfAgentDeps { home?: string; fetch?: typeof fetch }

export async function sendSelfRequest(request: Record<string, unknown>, deps: SelfAgentDeps = {}): Promise<SelfResult> {
  const endpoint = readSelfSurfaceEndpoint(deps.home);
  if (!endpoint) return { ok: false, verb: null, code: 'no_console', error: 'No running Phantom console published a self-surface endpoint. Start it with `phm verse` or open the desktop app.' };
  try {
    const response = await (deps.fetch ?? fetch)(`${endpoint.url}${SELF_REQUEST_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SELF_TOKEN_HEADER]: endpoint.token },
      body: JSON.stringify(request),
    });
    const body = await response.json() as SelfResult;
    return body && typeof body === 'object' && 'ok' in body ? body : { ok: false, verb: null, code: 'invalid', error: 'The console answered without a result.' };
  } catch {
    return { ok: false, verb: null, code: 'no_console', error: 'The Phantom console did not answer on loopback.' };
  }
}

export const SELF_CHECK_SECTIONS = ['command', 'fleet', 'growth', 'mind', 'chat', 'agents', 'settings'] as const;
export const SELF_CHECK_SLOW_MS = 2_000;
export const SELF_CHECK_DRIFT = 0.4;
export const SELF_CHECK_SCHEMA = 'phantom.self-check.v1';

export interface ScreenMeasure { nodeCount: number; scrollHeight: number }
export interface ScreenCheck {
  section: string;
  ok: boolean;
  loadMs: number | null;
  consoleErrors: string[];
  screenshot: string | null;
  measure: ScreenMeasure | null;
  flags: string[];
}
export interface SelfCheckReport { schema: typeof SELF_CHECK_SCHEMA; ok: boolean; at: string; screens: ScreenCheck[]; baseline: 'compared' | 'recorded' | 'none' }

const baselinePath = (home: string) => join(home, 'self-surface', 'baseline.json');

function readBaseline(home: string): Record<string, ScreenMeasure> {
  if (!existsSync(baselinePath(home))) return {};
  try {
    const raw = JSON.parse(readFileSync(baselinePath(home), 'utf8')) as { screens?: Record<string, ScreenMeasure> };
    return raw.screens && typeof raw.screens === 'object' ? raw.screens : {};
  } catch { return {}; }
}

function drift(now: number, then: number): boolean {
  return then > 0 && Math.abs(now - then) / then > SELF_CHECK_DRIFT;
}

export async function runSelfCheck(options: SelfAgentDeps & { updateBaseline?: boolean; sections?: readonly string[] } = {}): Promise<SelfCheckReport | SelfResult> {
  const home = options.home ?? ashlrHome();
  const baseline = readBaseline(home);
  const screens: ScreenCheck[] = [];
  for (const section of options.sections ?? SELF_CHECK_SECTIONS) {
    const opened = await sendSelfRequest({ verb: 'navigate', section }, options);
    if (!opened.ok && (opened.code === 'no_console' || opened.code === 'no_client' || opened.code === 'killed' || opened.code === 'comms_paused')) return opened;
    const nav = opened.ok ? opened.data as { loadMs?: number; stillLoading?: boolean; consoleErrors?: string[] } : {};
    const snap = await sendSelfRequest({ verb: 'snapshot' }, options);
    const shot = await sendSelfRequest({ verb: 'screenshot' }, options);
    const view = snap.ok ? snap.data as { nodeCount?: number; scrollHeight?: number; overflowX?: boolean; consoleErrors?: string[]; nodes?: unknown[]; route?: { section?: string } } : null;
    const flags: string[] = [];
    if (!opened.ok) flags.push(`navigate failed: ${opened.error}`);
    if (!view) flags.push(`snapshot failed: ${snap.ok ? 'empty' : snap.error}`);
    const loadMs = typeof nav.loadMs === 'number' ? nav.loadMs : null;
    if (loadMs !== null && loadMs > SELF_CHECK_SLOW_MS) flags.push(`slow load: ${loadMs} ms`);
    if (nav.stillLoading) flags.push('still loading when captured');
    const consoleErrors = nav.consoleErrors ?? [];
    if (consoleErrors.length > 0) flags.push(`${consoleErrors.length} console error(s)`);
    const measure = view && typeof view.nodeCount === 'number' && typeof view.scrollHeight === 'number' ? { nodeCount: view.nodeCount, scrollHeight: view.scrollHeight } : null;
    if (view?.route?.section && view.route.section !== section) flags.push(`landed on ${view.route.section}`);
    if (view?.overflowX) flags.push('horizontal overflow');
    if (view && (view.nodes?.length ?? 0) === 0) flags.push('empty screen');
    const before = baseline[section];
    if (measure && before && !options.updateBaseline) {
      if (drift(measure.nodeCount, before.nodeCount)) flags.push(`node count ${before.nodeCount} -> ${measure.nodeCount}`);
      if (drift(measure.scrollHeight, before.scrollHeight)) flags.push(`page height ${before.scrollHeight} -> ${measure.scrollHeight}`);
    }
    if (!shot.ok) flags.push(`screenshot failed: ${shot.error}`);
    screens.push({ section, ok: flags.length === 0, loadMs, consoleErrors, screenshot: shot.ok ? String((shot.data as { path?: string }).path ?? '') || null : null, measure, flags });
  }
  let state: SelfCheckReport['baseline'] = Object.keys(baseline).length > 0 ? 'compared' : 'none';
  if (options.updateBaseline) {
    const record = Object.fromEntries(screens.filter((s) => s.measure).map((s) => [s.section, s.measure]));
    mkdirSync(join(home, 'self-surface'), { recursive: true, mode: 0o700 });
    writeFileSync(baselinePath(home), JSON.stringify({ schema: SELF_CHECK_SCHEMA, screens: record }, null, 2) + '\n', { mode: 0o600 });
    state = 'recorded';
  }
  return { schema: SELF_CHECK_SCHEMA, ok: screens.every((s) => s.ok), at: new Date().toISOString(), screens, baseline: state };
}
