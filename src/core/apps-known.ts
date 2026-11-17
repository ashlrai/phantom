/**
 * The Mac apps Phantom knows by name (RQ-APPSN17VQ8): Phantom itself, the
 * Claude, Codex, ChatGPT, Cursor and Grok desktop apps, and Safari as
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
 * whatever apps-allow.json says.
 */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const KNOWN_APP_IDS = ['phantom', 'claude', 'codex', 'chatgpt', 'cursor', 'grok', 'safari'] as const;
export type KnownAppId = (typeof KNOWN_APP_IDS)[number];

export interface KnownApp {
  id: KnownAppId;
  name: string;
  /** What Phantom uses the app for, in plain words. */
  role: string;
  /** `.app` bundle file names to look for, in order. */
  bundles: readonly string[];
  /** Bundle ids accepted as a name for this app. Matching installed apps still goes by path. */
  bundleIds: readonly string[];
  quit: 'allowed' | 'protected';
}

export const KNOWN_APPS: readonly KnownApp[] = [
  { id: 'phantom', name: 'Phantom', role: 'This app', bundles: ['Phantom.app'], bundleIds: ['ai.ashlr.desktop'], quit: 'protected' },
  { id: 'claude', name: 'Claude', role: 'Assistant', bundles: ['Claude.app'], bundleIds: ['com.anthropic.claudefordesktop'], quit: 'protected' },
  { id: 'codex', name: 'Codex', role: 'Coding agent', bundles: ['Codex.app'], bundleIds: [], quit: 'protected' },
  { id: 'chatgpt', name: 'ChatGPT', role: 'Assistant', bundles: ['ChatGPT.app'], bundleIds: ['com.openai.chat'], quit: 'protected' },
  { id: 'cursor', name: 'Cursor', role: 'Editor', bundles: ['Cursor.app'], bundleIds: ['com.todesktop.230313mzl4w4u92'], quit: 'protected' },
  { id: 'grok', name: 'Grok', role: 'Assistant', bundles: ['Grok.app'], bundleIds: [], quit: 'protected' },
  { id: 'safari', name: 'Safari', role: 'Phantom’s agent browser', bundles: ['Safari.app'], bundleIds: ['com.apple.Safari'], quit: 'allowed' },
];

/** Exact id, display name or listed bundle id, case-insensitive. */
export function findKnownApp(target: string | null | undefined): KnownApp | undefined {
  const needle = target?.trim().toLowerCase();
  if (!needle) return undefined;
  return KNOWN_APPS.find(a => a.id === needle || a.name.toLowerCase() === needle || a.bundleIds.some(b => b.toLowerCase() === needle));
}

export const protectedQuitReason = (app: KnownApp): string =>
  `${app.name} is one of your apps, and Phantom never quits your apps. Quit it yourself if you need to.`;

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
  /** Resident memory of the app and its helper processes, in MB; null when unknown or not running. */
  memoryMb: number | null;
  path: string | null;
  bundleId: string | null;
  quit: 'allowed' | 'protected';
  /** The one obvious action, or null when there is nothing to do (or it is Phantom itself). */
  action: MacAppAction | null;
  /** Why a column is unknown; null when every column was read. */
  reason: string | null;
}

export interface MacAppsReport {
  schema: 'phm.apps/1';
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
export async function readMacApps(opts: { probe?: MacAppsProbe | null; home?: string } = {}): Promise<MacAppsReport> {
  const probe = opts.probe === undefined ? defaultMacAppsProbe() : opts.probe;
  const base = (app: KnownApp): MacAppRow => ({
    id: app.id, name: app.name, role: app.role, installed: null, running: null, frontmost: null, memoryMb: null,
    path: null, bundleId: null, quit: app.quit, action: null, reason: PROBE_MISSING_REASON,
  });
  if (!probe) return { schema: 'phm.apps/1', probe: 'missing', reason: PROBE_MISSING_REASON, apps: KNOWN_APPS.map(base) };

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
    const reasons = [...(procs.ok ? [] : [`running state: ${procs.reason}`]), ...(front.ok ? [] : [`frontmost: ${front.reason}`])];
    const row: MacAppRow = {
      ...base(app), installed: true, running, frontmost,
      memoryMb: mine && mine.length > 0 ? Math.round(mine.reduce((n, p) => n + p.rssKb, 0) / 1024) : null,
      path: found.value.path, bundleId: found.value.bundleId, reason: reasons.length ? reasons.join('; ') : null,
    };
    return { ...row, action: nextAction(row) };
  }));
  return { schema: 'phm.apps/1', probe: failures.size ? 'partial' : 'ok', reason: failures.size ? [...failures].join('; ') : null, apps };
}

const stateText = (r: MacAppRow): string => {
  if (r.installed === null) return 'unknown';
  if (!r.installed) return 'not installed';
  if (r.running === null) return 'installed, running unknown';
  if (!r.running) return 'not running';
  return [r.frontmost === true ? 'running, frontmost' : r.frontmost === null ? 'running, frontmost unknown' : 'running',
    ...(r.memoryMb !== null ? [`${r.memoryMb} MB`] : [])].join(' · ');
};

export function formatMacApps(report: MacAppsReport): string {
  const width = Math.max(...report.apps.map(a => a.name.length));
  const lines = report.apps.map(a => `${a.name.padEnd(width)}  ${stateText(a)}${a.action ? `  → phm apps ${a.action} ${a.id}` : ''}`);
  if (report.reason) lines.push('', `Unknown: ${report.reason}`);
  lines.push('', 'Phantom never quits your apps. Only Safari, its own browser, can be quit.');
  return lines.join('\n');
}
