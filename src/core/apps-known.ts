/**
 * The Mac apps Phantom knows by name (RQ-APPSN17VQ8): Phantom itself, the
 * Claude, Codex, ChatGPT, Cursor, Grok and Devin desktop apps, and Safari as
 * Phantom's own agent browser. `phm apps` and the Fleet Host "Apps" card read
 * this one report; `phm apps open|focus <name>` act on it through
 * runAppsControl (apps-control.ts), which owns feed logging, KILL/pause and
 * the needs-you route.
 *
 * READ ONLY. The host probe uses the filesystem, `plutil`, `ps` and
 * `lsappinfo`: no osascript, no Accessibility, no TCC prompt, nothing that
 * launches or raises an app. Apps are matched by their `.app` path, never by
 * bundle id alone: on a real Mac ChatGPT.app reports `com.openai.codex`, so a
 * bundle-id match would mislabel it. Every column the probe cannot read is
 * `null` with a plain reason, never a guess.
 *
 * QUIT. Only Safari, Phantom's own browser, may be quit. Every other app here
 * is the owner's GUI app and is protected: quit refuses with a plain reason,
 * whatever apps-allow.json says. Chrome, the owner's own browser, is not in
 * the list and is never quit either (ownerBrowserQuitReason).
 *
 * SUGGEST. suggestApps ranks idle apps by memory for a given memory pressure.
 * It is a pure function of the report: it never quits anything.
 */
import { execFile } from 'node:child_process';
import { lastUsedText } from './apps-last-used.js';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { scanBusInbox } from './fleet/bus-inbox.js';

export const KNOWN_APP_IDS = ['phantom', 'claude', 'codex', 'chatgpt', 'cursor', 'grok', 'devin', 'safari'] as const;
export type KnownAppId = (typeof KNOWN_APP_IDS)[number];

/** What kind of app it is, for agents: typed, unlike the plain-words `role`. */
export type AppKind = 'agent-app' | 'browser' | 'ide' | 'phantom';

export interface KnownApp {
  id: KnownAppId;
  name: string;
  kind: AppKind;
  /** What Phantom uses the app for, in plain words. */
  role: string;
  /** `.app` bundle file names to look for, in order. */
  bundles: readonly string[];
  /** Bundle ids accepted as a name for this app. Matching installed apps still goes by path. */
  bundleIds: readonly string[];
  quit: 'allowed' | 'protected';
}

export const KNOWN_APPS: readonly KnownApp[] = [
  { id: 'phantom', kind: 'phantom', name: 'Phantom', role: 'This app', bundles: ['Phantom.app'], bundleIds: ['ai.ashlr.desktop'], quit: 'protected' },
  { id: 'claude', kind: 'agent-app', name: 'Claude', role: 'Assistant', bundles: ['Claude.app'], bundleIds: ['com.anthropic.claudefordesktop'], quit: 'protected' },
  { id: 'codex', kind: 'agent-app', name: 'Codex', role: 'Coding agent', bundles: ['Codex.app'], bundleIds: [], quit: 'protected' },
  { id: 'chatgpt', kind: 'agent-app', name: 'ChatGPT', role: 'Assistant', bundles: ['ChatGPT.app'], bundleIds: ['com.openai.chat'], quit: 'protected' },
  { id: 'cursor', kind: 'ide', name: 'Cursor', role: 'Editor', bundles: ['Cursor.app'], bundleIds: ['com.todesktop.230313mzl4w4u92'], quit: 'protected' },
  { id: 'grok', kind: 'agent-app', name: 'Grok', role: 'Assistant', bundles: ['Grok.app'], bundleIds: [], quit: 'protected' },
  { id: 'devin', kind: 'agent-app', name: 'Devin', role: 'Coding agent', bundles: ['Devin.app'], bundleIds: ['ai.cognition.devin'], quit: 'protected' },
  { id: 'safari', kind: 'browser', name: 'Safari', role: 'Phantom’s agent browser', bundles: ['Safari.app'], bundleIds: ['com.apple.Safari'], quit: 'allowed' },
];

/** Exact id, display name or listed bundle id, case-insensitive. */
export function findKnownApp(target: string | null | undefined): KnownApp | undefined {
  const needle = target?.trim().toLowerCase();
  if (!needle) return undefined;
  return KNOWN_APPS.find(a => a.id === needle || a.name.toLowerCase() === needle || a.bundleIds.some(b => b.toLowerCase() === needle));
}

export const protectedQuitReason = (app: KnownApp): string =>
  `${app.name} is one of your apps, and Phantom never quits your apps. Quit it yourself if you need to.`;

/** Chrome is the owner's own browser: never quit, whatever name, bundle id or allowlist entry points at it. */
export function ownerBrowserQuitReason(...targets: Array<string | null | undefined>): string | null {
  return targets.some(t => /^(google )?chrome$|^com\.google\.chrome(\.|$)/i.test(t?.trim() ?? ''))
    ? 'Chrome is your own browser, and Phantom never quits it. Quit it yourself if you need to.' : null;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export interface LocatedApp { path: string; bundleId: string | null }
export interface ProbeProcess { pid: number; rssKb: number; path: string }

/**
 * Injectable host reads. Each method may throw; that column becomes unknown
 * with the error as its reason. Tests pass fixtures; nothing here acts.
 */
export interface MacAppsProbe {
  /** First existing bundle among absolute candidate paths, or null when none exists. */
  locate(candidates: readonly string[]): Promise<LocatedApp | null>;
  /** Every process with its executable path and resident memory. */
  processes(): Promise<ProbeProcess[]>;
  /** Bundle path of the frontmost app, or null when there is none. */
  frontmost(): Promise<string | null>;
  /**
   * When the app last came to the front, as epoch ms; `null` when macOS says it
   * never has. Throws when the answer cannot be read or parsed. Optional: a probe
   * without it leaves the column unknown.
   */
  lastFocused?(bundleId: string): Promise<number | null>;
}

const EXEC_TIMEOUT_MS = 5_000;

function run(file: string, args: readonly string[]): Promise<string> {
  const fail = (error: Error) => new Error(`${file.split('/').pop()} failed: ${error.message.split('\n')[0]!.slice(0, 160)}`);
  return new Promise((resolve, reject) => {
    // A sandbox can make spawn throw synchronously (EPERM); report it like any other failure.
    try {
      execFile(file, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(fail(error)); else resolve(stdout);
      });
    } catch (error) { reject(fail(error instanceof Error ? error : new Error(String(error)))); }
  });
}

/** `ps -axo pid=,rss=,comm=`; comm is last because a bundle path may contain spaces. */
export function parsePsRows(text: string): ProbeProcess[] {
  const rows: ProbeProcess[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\/.+?)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), rssKb: Number(m[2]), path: m[3]! });
  }
  return rows;
}

/** `lsappinfo info -only bundlepath <asn>` prints `"LSBundlePath"="/Applications/X.app"`. */
export function parseLsBundlePath(text: string): string | null {
  const m = /"LSBundlePath"="([^"]+)"/.exec(text);
  return m ? m[1]! : null;
}

/** What `lsappinfo info -only lastActivationTime <asn>` said: a local time, "never", or unreadable. */
export type LsLastActivation = { state: 'at'; ms: number } | { state: 'never' } | { state: 'unknown' };

/**
 * Parses `"lastActivationTime"="2026/11/18 14:12:42 ..."` (lsappinfo's own local-time
 * format) or `"lastActivationTime"=[ NULL ]` (never focused). Anything else is unknown,
 * never a guessed time.
 */
export function parseLsLastActivation(text: string): LsLastActivation {
  const line = text.split('\n').find(l => l.trim().startsWith('"lastActivationTime"'));
  if (!line) return { state: 'unknown' };
  if (/=\s*\[\s*NULL\s*\]/.test(line)) return { state: 'never' };
  const m = /=\s*"?(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(line);
  if (!m) return { state: 'unknown' };
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, se);
  const ok = date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
  return ok ? { state: 'at', ms: date.getTime() } : { state: 'unknown' };
}

/** macOS host probe; `null` elsewhere so every row says why it is unknown. */
export function defaultMacAppsProbe(platform = process.platform): MacAppsProbe | null {
  if (platform !== 'darwin') return null;
  return {
    async locate(candidates) {
      for (const path of candidates) {
        if (!existsSync(join(path, 'Contents', 'Info.plist'))) continue;
        let bundleId: string | null = null;
        try { bundleId = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(path, 'Contents', 'Info.plist')])).trim() || null; }
        catch { bundleId = null; }
        return { path, bundleId };
      }
      return null;
    },
    async processes() { return parsePsRows(await run('/bin/ps', ['-axww', '-o', 'pid=,rss=,comm='])); },
    async frontmost() {
      const asn = (await run('/usr/bin/lsappinfo', ['front'])).trim();
      if (!/^ASN:[0-9a-fx-]+:?$/i.test(asn)) return null;
      return parseLsBundlePath(await run('/usr/bin/lsappinfo', ['info', '-only', 'bundlepath', asn]));
    },
    async lastFocused(bundleId) {
      const asn = (await run('/usr/bin/lsappinfo', ['find', `bundleid=${bundleId}`])).trim();
      if (!/^ASN:[0-9a-fx-]+:?$/i.test(asn)) throw new Error('lsappinfo found no running app');
      const result = parseLsLastActivation(await run('/usr/bin/lsappinfo', ['info', '-only', 'lastActivationTime', asn]));
      if (result.state === 'unknown') throw new Error('lsappinfo gave an unreadable time');
      return result.state === 'at' ? result.ms : null;
    },
  };
}

/** Where each bundle may live. Safari ships in the system cryptex on current macOS. */
export function candidatePaths(app: KnownApp, home = homedir()): string[] {
  const dirs = ['/Applications', join(home, 'Applications'), ...(app.id === 'safari' ? ['/System/Cryptexes/App/System/Applications', '/System/Applications'] : [])];
  return app.bundles.flatMap(b => dirs.map(d => join(d, b)));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type MacAppAction = 'open' | 'focus';

export interface MacAppRow {
  id: KnownAppId;
  name: string;
  role: string;
  /** null = unknown; see `reason`. */
  installed: boolean | null;
  running: boolean | null;
  frontmost: boolean | null;
  /** Pid of the app's main process; null when unknown or not running. */
  pid: number | null;
  /** Resident memory of the app and its helper processes, in MB; null when unknown or not running. */
  memoryMb: number | null;
  path: string | null;
  bundleId: string | null;
  quit: 'allowed' | 'protected';
  /** The one obvious action, or null when there is nothing to do (or it is Phantom itself). */
  action: MacAppAction | null;
  /** When the app last came to the front (ISO time); null when it never has or this is unknown, see `lastFocus`. */
  lastFocusedAt: string | null;
  /** `known`: `lastFocusedAt` is set; `never`: running but never brought to the front; `unknown`: not read. */
  lastFocus: 'known' | 'never' | 'unknown';
  /** Why a column is unknown; null when every column was read. */
  reason: string | null;
  kind: AppKind;
  /** Name of the running main executable, as `ps` shows it; null when unknown or not running. */
  processName: string | null;
  /** Latest open, focus, quit or restart recorded in the feed; null when none is on record. */
  lastAction: MacAppLastAction | null;
}

export interface MacAppLastAction { action: string; outcome: string; at: string }

/** The latest acted-on result per known app, from the `apps-control` feed lines runAppsControl writes. */
export function readLastAppActions(scan: () => Pick<ReturnType<typeof scanBusInbox>, 'rows'> = scanBusInbox): Map<KnownAppId, MacAppLastAction> {
  const last = new Map<KnownAppId, MacAppLastAction & { ms: number }>();
  for (const row of scan().rows) {
    const body = row.envelope.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.kind !== 'apps-control' || body.phase !== 'result') continue;
    const { action, outcome, app } = body;
    if (typeof action !== 'string' || typeof outcome !== 'string' || typeof app !== 'string' || action === 'list' || action === 'status') continue;
    const known = findKnownApp(app);
    if (known && row.receivedAt >= (last.get(known.id)?.ms ?? 0)) last.set(known.id, { action, outcome, at: new Date(row.receivedAt).toISOString(), ms: row.receivedAt });
  }
  return new Map([...last].map(([id, { action, outcome, at }]) => [id, { action, outcome, at }]));
}

export interface MacAppsReport {
  schema: 'phm.apps/2';
  /** Bumps only on a breaking change; new fields are additive. 2 added lastFocusedAt and lastFocus. */
  version: 2;
  /** `missing`: no probe on this host; `partial`: some reads failed. */
  probe: 'ok' | 'partial' | 'missing';
  reason: string | null;
  apps: MacAppRow[];
}

const settle = async <T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: string }> => {
  try { return { ok: true, value: await read() }; }
  catch (error) { return { ok: false, reason: error instanceof Error && error.message ? error.message.slice(0, 200) : 'read failed' }; }
};

const realOr = (path: string): string => { try { return realpathSync(path); } catch { return path; } };

export const PROBE_MISSING_REASON = 'app state can only be read on macOS; this host has no app probe.';

export function nextAction(row: Pick<MacAppRow, 'id' | 'installed' | 'running' | 'frontmost'>): MacAppAction | null {
  if (row.id === 'phantom' || row.installed !== true) return null;
  if (row.running === false || row.running === null) return 'open';
  return row.frontmost === true ? null : 'focus';
}

/** One row per known app, always in catalog order, so the JSON shape is stable. */
export async function readMacApps(opts: { probe?: MacAppsProbe | null; home?: string; lastActions?: () => Map<KnownAppId, MacAppLastAction> } = {}): Promise<MacAppsReport> {
  const probe = opts.probe === undefined ? defaultMacAppsProbe() : opts.probe;
  const last = (opts.lastActions ?? readLastAppActions)();
  const base = (app: KnownApp): MacAppRow => ({
    id: app.id, name: app.name, role: app.role, installed: null, running: null, frontmost: null, pid: null, memoryMb: null,
    path: null, bundleId: null, lastFocusedAt: null, lastFocus: 'unknown', quit: app.quit, action: null, reason: PROBE_MISSING_REASON,
    kind: app.kind, processName: null, lastAction: last.get(app.id) ?? null,
  });
  if (!probe) return { schema: 'phm.apps/2', version: 2, probe: 'missing', reason: PROBE_MISSING_REASON, apps: KNOWN_APPS.map(base) };

  const [procs, front] = await Promise.all([settle(() => probe.processes()), settle(() => probe.frontmost())]);
  const frontPath = front.ok && front.value ? realOr(front.value) : null;
  const failures = new Set<string>();
  if (!procs.ok) failures.add(`running state: ${procs.reason}`);
  if (!front.ok) failures.add(`frontmost: ${front.reason}`);

  const apps = await Promise.all(KNOWN_APPS.map(async (app): Promise<MacAppRow> => {
    const found = await settle(() => probe.locate(candidatePaths(app, opts.home)));
    if (!found.ok) {
      failures.add(`installed: ${found.reason}`);
      return { ...base(app), reason: `could not check whether ${app.name} is installed: ${found.reason}` };
    }
    if (!found.value) {
      return { ...base(app), installed: false, running: false, frontmost: false, reason: null };
    }
    const roots = [...new Set([found.value.path, realOr(found.value.path)])];
    const inside = (p: string): boolean => roots.some(r => p === r || p.startsWith(`${r}/`));
    const mine = procs.ok ? procs.value.filter(p => inside(p.path)) : null;
    const running = mine ? mine.length > 0 : null;
    const frontmost = !front.ok ? null : running === false ? false : frontPath !== null && inside(frontPath);
    // Read only for a running app; a failed or missing read stays unknown, never now or 0.
    let focus: Pick<MacAppRow, 'lastFocusedAt' | 'lastFocus'> = { lastFocusedAt: null, lastFocus: 'unknown' };
    let focusReason: string | null = null;
    if (running === true && found.value.bundleId && probe.lastFocused) {
      const read = await settle(() => probe.lastFocused!(found.value!.bundleId!));
      if (!read.ok) { focusReason = `last used: ${read.reason}`; failures.add(focusReason); }
      else if (read.value === null) focus = { lastFocusedAt: null, lastFocus: 'never' };
      else if (Number.isFinite(read.value) && read.value > 0) focus = { lastFocusedAt: new Date(read.value).toISOString(), lastFocus: 'known' };
    }
    const reasons = [...(focusReason ? [focusReason] : []), ...(procs.ok ? [] : [`running state: ${procs.reason}`]), ...(front.ok ? [] : [`frontmost: ${front.reason}`])];
    // The main process runs from Contents/MacOS; helpers live deeper in the bundle.
    const main = mine?.find(p => roots.some(r => p.path.startsWith(`${r}/Contents/MacOS/`)));
    const row: MacAppRow = {
      ...base(app), installed: true, running, frontmost, processName: main ? basename(main.path) : null,
      pid: mine && mine.length > 0 ? (main ?? mine.reduce((a, b) => a.pid <= b.pid ? a : b)).pid : null,
      memoryMb: mine && mine.length > 0 ? Math.round(mine.reduce((n, p) => n + p.rssKb, 0) / 1024) : null,
      path: found.value.path, bundleId: found.value.bundleId, ...focus, reason: reasons.length ? reasons.join('; ') : null,
    };
    return { ...row, action: nextAction(row) };
  }));
  return { schema: 'phm.apps/2', version: 2, probe: failures.size ? 'partial' : 'ok', reason: failures.size ? [...failures].join('; ') : null, apps };
}

const stateText = (r: MacAppRow, now: number): string => {
  if (r.installed === null) return 'unknown';
  if (!r.installed) return 'not installed';
  if (r.running === null) return 'installed, running unknown';
  if (!r.running) return 'not running';
  return [r.frontmost === true ? 'running, frontmost' : r.frontmost === null ? 'running, frontmost unknown' : 'running',
    ...(r.pid !== null ? [`pid ${r.pid}`] : []), ...(r.memoryMb !== null ? [`${r.memoryMb} MB`] : []), `last used ${lastUsedText(r, now)}`].join(' · ');
};

export function formatMacApps(report: MacAppsReport, now: number = Date.now()): string {
  const width = Math.max(...report.apps.map(a => a.name.length));
  const lines = report.apps.map(a => `${a.name.padEnd(width)}  ${stateText(a, now)}${a.action ? `  → phm apps ${a.action} ${a.id}` : ''}`);
  if (report.reason) lines.push('', `Unknown: ${report.reason}`);
  lines.push('', 'Phantom never quits your apps. Only Safari, its own browser, can be quit.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Suggest (read-only)
// ---------------------------------------------------------------------------

export const MEMORY_PRESSURES = ['normal', 'warning', 'critical'] as const;
export type MemoryPressureInput = (typeof MEMORY_PRESSURES)[number];

export interface AppsSuggestion {
  id: KnownAppId; name: string; pid: number | null; memoryMb: number;
  /** The command that closes it, or null when it is the owner's app to close by hand. */
  command: string | null;
}

export interface AppsSuggestReport {
  schema: 'phm.apps.suggest/1';
  version: 1;
  /** The pressure the caller gave; `unknown` when none was given. Never measured here. */
  pressure: MemoryPressureInput | 'unknown';
  needMb: number | null;
  /** Idle apps (running, not in front), biggest first. Nothing here was quit. */
  suggestions: AppsSuggestion[];
  totalMb: number;
  /** Whether the suggestions cover `needMb`; null when no target was given. */
  covers: boolean | null;
  summary: string;
  /** Why some app state was unknown and left out; null when all of it was read. */
  reason: string | null;
}

/**
 * Which idle known apps would free the most memory. Idle means running and known not to be in
 * front; unknown state is left out, never guessed. Normal pressure with no target suggests nothing.
 * With `needMb`, the list stops at the fewest apps that cover it.
 */
export function suggestApps(report: MacAppsReport, input: { pressure?: MemoryPressureInput; needMb?: number } = {}): AppsSuggestReport {
  const needMb = input.needMb ?? null;
  const idle = report.apps
    .filter(a => a.id !== 'phantom' && a.running === true && a.frontmost === false && a.memoryMb !== null && a.memoryMb > 0)
    .sort((a, b) => b.memoryMb! - a.memoryMb!);
  const wanted = input.pressure === 'normal' && needMb === null ? [] : idle;
  const picked: MacAppRow[] = [];
  for (const row of wanted) {
    if (needMb !== null && picked.reduce((n, r) => n + r.memoryMb!, 0) >= needMb) break;
    picked.push(row);
  }
  const totalMb = picked.reduce((n, r) => n + r.memoryMb!, 0);
  const covers = needMb === null ? null : totalMb >= needMb;
  const summary = input.pressure === 'normal' && needMb === null ? 'Memory is fine. Nothing needs to close.'
    : picked.length === 0 ? 'No idle app to close.'
    : `Closing ${picked.map(r => r.name).join(', ')} would free about ${totalMb} MB${covers === false ? `, short of the ${needMb} MB asked for` : ''}.`;
  return {
    schema: 'phm.apps.suggest/1', version: 1, pressure: input.pressure ?? 'unknown', needMb,
    suggestions: picked.map(r => ({ id: r.id, name: r.name, pid: r.pid, memoryMb: r.memoryMb!, command: r.quit === 'allowed' ? `phm apps quit ${r.id}` : null })),
    totalMb, covers, summary, reason: report.reason,
  };
}

export function formatAppsSuggest(report: AppsSuggestReport): string {
  const width = Math.max(0, ...report.suggestions.map(s => s.name.length));
  return [
    ...report.suggestions.map(s => `${s.name.padEnd(width)}  ${s.memoryMb} MB  ${s.command ? `→ ${s.command}` : 'close it yourself'}`),
    ...(report.suggestions.length ? [''] : []), report.summary,
    ...(report.pressure === 'unknown' ? ['No memory pressure was given, so every idle app is listed.'] : []),
    ...(report.reason ? [`Unknown: ${report.reason}`] : []), 'Nothing was quit.',
  ].join('\n');
}
