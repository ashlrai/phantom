import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from './cloud/store.js';
import { appendBusInbox } from './fleet/bus-inbox.js';
import { scrubSecrets } from './util/scrub.js';
import { defaultHostAppLauncher, openCommand } from './verse/app-launcher.js';
import {
  createAppControl, type AppControlResult, type AppLauncher, type RunningApp, type ToolCall,
} from './verse/desktop-adapters.js';
import { appendNeedsMasonLine } from './fleet/needs-mason-append.js';
import { killSwitchOn } from './sandbox/policy.js';
import { isPaused } from './comms/pause.js';
import { computerAppPolicy } from './verse/computer-types.js';
import { ACCESSIBILITY_PANE } from './desktop/operator-policy.js';
import { findKnownApp, ownerBrowserQuitReason, protectedQuitReason, readMacApps, type KnownApp, type MacAppsProbe } from './apps-known.js';

export const APP_ACTIONS = ['open', 'quit', 'focus', 'status', 'restart'] as const;
/** How long a quit may take before the app's state is reported as unknown. */
export const QUIT_WAIT_MS = 10_000;
const QUIT_POLL_MS = 250;
export type AppAction = (typeof APP_ACTIONS)[number];
type Verb = AppAction | 'list';

export interface AllowedApp { name: string; bundleId: string | null; actions?: AppAction[]; mode?: 'direct' | 'request' }
export type AllowlistRead = { ok: true; apps: AllowedApp[] } | { ok: false; error: string };

const MAX_ALLOWED = 64;
const BUNDLE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const NAME = /^[^\p{Cc}]{1,120}$/u;

/** Entries are a name, a bundle id, or `{ "name", "bundleId" }`. A missing file is an empty list. */
export function parseAllowlist(text: string): AllowlistRead {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, error: 'apps-allow.json is not valid JSON.' }; }
  const list = Array.isArray(json) ? json : json && typeof json === 'object' ? (json as { apps?: unknown }).apps : undefined;
  if (!Array.isArray(list) || list.length > MAX_ALLOWED) return { ok: false, error: `apps-allow.json must hold an "apps" array of at most ${MAX_ALLOWED} entries.` };
  const apps: AllowedApp[] = [];
  for (const entry of list) {
    if (typeof entry === 'string' && NAME.test(entry.trim())) {
      const value = entry.trim();
      apps.push(BUNDLE.test(value) ? { name: value, bundleId: value } : { name: value, bundleId: null });
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      if (Object.keys(entry).some(k => !['name', 'bundleId', 'actions', 'mode'].includes(k))) return { ok: false, error: 'apps-allow.json has an unknown policy field.' };
      const { name, bundleId, actions, mode } = entry as Record<string, unknown>;
      if (typeof name !== 'string' || !NAME.test(name.trim()) || (bundleId !== undefined && (typeof bundleId !== 'string' || !BUNDLE.test(bundleId)))) {
        return { ok: false, error: 'apps-allow.json has a malformed entry.' };
      }
      if ((actions !== undefined && (!Array.isArray(actions) || actions.some(a => !APP_ACTIONS.includes(a)) || new Set(actions).size !== actions.length)) ||
        (mode !== undefined && mode !== 'direct' && mode !== 'request')) return { ok: false, error: 'apps-allow.json has an invalid action policy.' };
      apps.push({ name: name.trim(), bundleId: (bundleId as string | undefined) ?? null,
        ...(actions === undefined ? {} : { actions: actions as AppAction[] }), ...(mode === undefined ? {} : { mode: mode as 'direct' | 'request' }) });
    } else return { ok: false, error: 'apps-allow.json has a malformed entry.' };
  }
  const keys = apps.flatMap(a => [...new Set([a.name.toLowerCase(), ...(a.bundleId ? [a.bundleId.toLowerCase()] : [])])]);
  if (new Set(keys).size !== keys.length) return { ok: false, error: 'apps-allow.json has ambiguous app names or bundle ids.' };
  return { ok: true, apps };
}

export function readAllowlist(path: string): AllowlistRead {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, apps: [] };
    return { ok: false, error: 'apps-allow.json could not be read.' };
  }
  return parseAllowlist(text);
}

const matches = (app: AllowedApp, target: string): boolean => {
  const needle = target.trim().toLowerCase();
  return app.name.toLowerCase() === needle || app.bundleId?.toLowerCase() === needle;
};

/** App names are untrusted text headed for a one-line ledger entry. */
const oneLine = (text: string): string => scrubSecrets(text.replace(/\p{Cc}/gu, ' ')).slice(0, 160);

export type AppsOutcome = 'done' | 'refused' | 'failed' | 'needs-you' | 'needs_permission' | 'unknown' | 'dry-run';
export interface AppsFeedEntry { phase: 'start' | 'result'; action: Verb; app: string; outcome?: AppsOutcome; detail?: string }

export interface AppsControlDeps {
  /** The `computer_*` transport. Absent means this shell has no desktop connection and actions fail closed. */
  call?: ToolCall;
  /**
   * Host launcher for open/focus. `undefined` uses `/usr/bin/open -b` on macOS only, and only when no
   * `call` is supplied (a shell with no desktop connection); `null` disables it.
   */
  launcher?: AppLauncher | null;
  allowFile?: string;
  /** Returns false when the entry could not be recorded. */
  feed?: (entry: AppsFeedEntry) => boolean;
  needsYou?: (text: string) => boolean;
  writesBlocked?: () => boolean;
  out?: (line: string) => void;
  /** Host app reads for the known apps (apps-known.ts). `undefined` uses the macOS probe; `null` means none. */
  probe?: MacAppsProbe | null;
  /** Home directory searched for `~/Applications`; tests pin it. */
  home?: string;
  /** Graceful-quit budget and its wait; tests pin both. */
  quitWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const notConnected: ToolCall = async () => ({
  content: [{ type: 'text', text: 'desktop control is not connected to this shell; run it from a Phantom desktop chat that holds the app grant.' }],
  isError: true,
});

function defaultFeed(entry: AppsFeedEntry): boolean {
  const body = { kind: 'apps-control', ...entry, detail: entry.detail === undefined ? undefined : oneLine(entry.detail), app: oneLine(entry.app) };
  const res = appendBusInbox({
    id: `apps-control-${randomUUID()}`, from: 'apps-control', to: 'mason', priority: 'P3', ttl: 7 * 24 * 60 * 60 * 1000,
    body: JSON.parse(JSON.stringify(body)),
  });
  return res.status === 'posted';
}

function defaultNeedsYou(text: string): boolean {
  try { appendNeedsMasonLine(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), text); return true; }
  catch { return false; }
}

/**
 * True only when the desktop's read-only permission preflight says Accessibility is missing.
 * Reads the stable `desktop-permissions:` line (formatComputerPermissionReport); anything else is not a no.
 */
async function accessibilityMissing(call: ToolCall): Promise<boolean> {
  try {
    const res = await call('computer_permissions', {});
    if (res.isError) return false;
    const line = res.content.flatMap(c => c.type === 'text' ? c.text.split('\n') : []).find(l => l.startsWith('desktop-permissions:'));
    return /\baccessibility=missing\b/.test(line ?? '');
  } catch { return false; }
}

export interface AppsActionReport {
  schema: 'phm.apps.action/1';
  /** Bumps only on a breaking change; new fields are additive. */
  version: 1;
  ok: boolean;
  action: Verb;
  app?: string;
  outcome: AppsOutcome;
  code?: string;
  detail: string;
  running?: boolean;
  frontmost?: boolean;
  pid?: number;
  memoryMb?: number;
  /** Set with outcome `needs_permission`: the one macOS permission to grant, and where. */
  permission?: { name: 'Accessibility'; settingsPath: string };
  /** Set with outcome `dry-run`: the exact steps a real run would take, in order. None was run. */
  commands?: string[];
  logged: boolean;
}

export interface AppsListReport {
  schema: 'phm.apps.allowed/1'; version: 1; ok: true; action: 'list'; allowFile: string;
  apps: Array<AllowedApp & { actions: AppAction[]; mode: 'direct' | 'request'; running: boolean | null; frontmost: boolean | null }>;
  connected: boolean; logged: boolean;
}
export type AppsReport = AppsActionReport | AppsListReport;
export interface AppsRequest { action: Verb; app?: string; request?: boolean; /** Check every rule and report the exact command; run and log nothing. */ dryRun?: boolean }
const isSelf = (app: AllowedApp): boolean => app.name.toLowerCase() === 'phantom' || app.bundleId?.toLowerCase() === 'ai.ashlr.desktop';
const modeOf = (app: AllowedApp): 'direct' | 'request' => isSelf(app) ? 'request' : app.mode ?? 'direct';

function protectedLiveApp(app: RunningApp): KnownApp | undefined {
  return [app.bundleId, app.name]
    .map(identity => identity ? findKnownApp(identity) : undefined)
    .find((known): known is KnownApp => known?.quit === 'protected');
}

/** Shared typed control surface. Neither console nor CLI owns an alternate execution path. */
export async function runAppsControl(input: AppsRequest, deps: AppsControlDeps = {}): Promise<{ exit: number; report: AppsReport; text: string }> {
  const { action: verb, app: target } = input;
  if ((verb !== 'list' && !APP_ACTIONS.includes(verb)) || (verb === 'list' ? target !== undefined || input.request === true : !target || target.startsWith('-') || /\p{Cc}/u.test(target) || target.length > 200) || (input.request === true && verb === 'status') ||
    (input.dryRun === true && (verb === 'list' || verb === 'status' || input.request === true))) {
    return { exit: 2, report: { schema: 'phm.apps.action/1', version: 1, ok: false, action: verb, outcome: 'refused', code: 'invalid-request', detail: 'invalid app control request.', logged: false }, text: 'invalid app control request.' };
  }
  let emitted!: AppsReport;
  let humanText = '';
  const exit = await (async (): Promise<number> => {
    const allowFile = deps.allowFile ?? join(ashlrHome(), 'apps-allow.json');
    const allow = readAllowlist(allowFile);
    const dryRun = input.dryRun === true;
    const isQuit = verb === 'quit' || verb === 'restart';
    // A dry run acts on nothing, so it logs nothing.
    const feed = dryRun ? () => true : deps.feed ?? defaultFeed;
    const launcher = deps.launcher === null ? undefined : deps.launcher ?? (deps.call === undefined ? defaultHostAppLauncher() : undefined);
    const makeControl = (openWithoutList = false) => createAppControl(deps.call ?? notConnected, { launcher, openWithoutList });
    const emit = (report: AppsReport, human: string): void => { emitted = report; humanText = human; };

    if (!allow.ok) {
      emit({ schema: 'phm.apps.action/1', version: 1, ok: false, action: verb, outcome: 'failed', detail: allow.error, logged: false }, allow.error);
      return 1;
    }

    if (verb === 'list') {
      const started = feed({ phase: 'start', action: 'list', app: '*' });
      const live = await makeControl().list();
      const running: RunningApp[] = live.ok ? live.apps : [];
      const rows = allow.apps.map((a) => {
        const hit = running.find((r) => a.bundleId ? r.bundleId?.toLowerCase() === a.bundleId.toLowerCase() : r.name.toLowerCase() === a.name.toLowerCase());
        return { name: a.name, bundleId: a.bundleId, actions: a.actions ?? [...APP_ACTIONS], mode: modeOf(a), running: live.ok ? hit !== undefined : null, frontmost: live.ok ? hit?.frontmost ?? false : null };
      });
      const logged = feed({ phase: 'result', action: 'list', app: '*', outcome: 'done', detail: `${rows.length} allowed` }) && started;
      emit({ schema: 'phm.apps.allowed/1', version: 1, ok: true, action: 'list', allowFile, apps: rows, connected: live.ok, logged },
        rows.length === 0 ? `No apps allowed. Add some to ${allowFile}.`
          : rows.map((r) => `${r.name}${r.bundleId ? ` (${r.bundleId})` : ''}: ${r.running === null ? 'unknown' : r.running ? `running${r.frontmost ? ', frontmost' : ''}` : 'not running'}`).join('\n'));
      return 0;
    }

    const requested = target!;
    const label = oneLine(requested);
    const listed = allow.apps.find((a) => matches(a, requested));
    // An explicit apps-allow.json entry is owner policy and wins. Without one, a known app
    // (apps-known.ts) may be opened, focused and read; only Safari may be quit.
    const known: KnownApp | undefined = findKnownApp(requested) ?? (listed ? findKnownApp(listed.name) ?? findKnownApp(listed.bundleId) : undefined);
    const allowed: AllowedApp | undefined = listed ?? (known ? {
      name: known.name, bundleId: known.bundleIds[0] ?? null,
      // quit stays listed so a protected app refuses with the plain reason below, not a policy code.
      actions: [...APP_ACTIONS],
    } : undefined);
    const finish = (report: Omit<AppsActionReport, 'logged' | 'action' | 'app' | 'version' | 'schema'>, resultLogged: boolean, human: string): void => {
      emit({ schema: 'phm.apps.action/1', version: 1, ...report, action: verb, app: label, logged: resultLogged }, human);
    };

    const started = feed({ phase: 'start', action: verb, app: label });
    const result = async (outcome: AppsOutcome, detail: string, extra: Partial<AppsActionReport> = {}, exit = outcome === 'done' ? 0 : 1): Promise<number> => {
      detail = oneLine(detail);
      const logged = feed({ phase: 'result', action: verb, app: label, outcome, detail }) && started && !dryRun;
      finish({ ok: outcome === 'done' || outcome === 'dry-run', outcome, detail, ...extra }, logged, `${label}: ${detail}`);
      return exit;
    };
    // The steps go out whole, one per line: the 160-character detail cap would cut a command short.
    const dry = (steps: string[], note = ''): number => {
      const commands = steps.map(oneLine);
      const detail = `${commands.length ? `would run ${commands.length === 1 ? 'one step' : `${commands.length} steps`}.` : note} Nothing was run.`;
      finish({ ok: true, outcome: 'dry-run', detail, commands }, false, [`${label}: ${detail}`, ...commands.map(c => `  ${c}`)].join('\n'));
      return 0;
    };

    if (!started) return result('refused', 'the feed could not record this action, so it was not run.', { code: 'feed-unavailable' });
    // Chrome is the owner's own browser: never quit, listed or not.
    const ownerBrowser = isQuit ? ownerBrowserQuitReason(requested, listed?.name, listed?.bundleId) : null;
    if (!allowed) return ownerBrowser ? result('refused', ownerBrowser, { code: 'protected' }) : result('refused', `not in ${allowFile}.`, { code: 'not-allowlisted' });
    if (!(allowed.actions ?? APP_ACTIONS).includes(verb)) return result('refused', 'action is not allowed by this app policy.', { code: 'action-not-allowed' });
    // The owner's GUI apps, Phantom included, are never quit or restarted, whatever the allowlist says.
    if (known && isQuit && known.quit === 'protected') return result('refused', protectedQuitReason(known), { code: 'protected' });
    if (ownerBrowser) return result('refused', ownerBrowser, { code: 'protected' });
    if (verb !== 'status' && allowed.bundleId && !isSelf(allowed) && computerAppPolicy(allowed.bundleId).ceiling === null) return result('refused', 'that app is never available to agents.', { code: 'denied' });
    if (verb !== 'status' && (deps.writesBlocked ?? (() => killSwitchOn() || isPaused()))()) return result('refused', 'app writes are stopped by KILL or comms pause.', { code: 'writes-blocked' });
    const queue = async (reason: string, code: string): Promise<number> => {
      const queued = (deps.needsYou ?? defaultNeedsYou)(oneLine(`App request: ${verb} ${allowed.name}. ${reason} Recheck allowlist and app state before acting.`));
      return queued ? result('needs-you', `${reason} Sent to needs-you.`, { code }, 3)
        : result('failed', 'needs-you could not record this request; no action was run.', { code: 'needs-you-unavailable' });
    };
    if (dryRun && modeOf(allowed) === 'request') return dry([], 'would be sent to needs-you for review.');
    if (verb !== 'status' && (input.request === true || modeOf(allowed) === 'request')) return queue('App-level action requested for review.', 'action-requested');

    // Known apps without an allowlist entry are read by the host probe and started or raised by
    // the host launcher; quit (Safari only) still needs the desktop connection's unsaved-work check.
    if (known && !listed && !isQuit) {
      const row = (await readMacApps({ probe: deps.probe, home: deps.home })).apps.find(a => a.id === known.id)!;
      const unknown = row.reason ?? 'the app probe could not read it.';
      if (verb === 'status') {
        return row.installed === null ? result('failed', `${row.name} state is unknown: ${unknown}`, { code: 'unknown' })
          : result('done', !row.installed ? 'not installed.' : row.running === null ? `installed; running state is unknown: ${unknown}`
            : row.running ? `running${row.frontmost ? ', frontmost' : ''}.` : 'not running.',
          { running: row.running ?? undefined, frontmost: row.frontmost ?? undefined, pid: row.pid ?? undefined, memoryMb: row.memoryMb ?? undefined });
      }
      if (row.installed === false) return result('failed', `${row.name} is not installed on this Mac.`, { code: 'not-installed' });
      if (row.installed === null || !row.bundleId) return result('failed', `cannot find ${row.name}'s bundle id: ${unknown}`, { code: 'unknown' });
      // The id read from the installed bundle is what launches, so the denylist checks that id too.
      if (computerAppPolicy(row.bundleId).ceiling === null) return result('refused', 'that app is never available to agents.', { code: 'denied' });
      if (verb === 'focus') {
        // Focus never starts an app: `open -b` would, so an unknown running state refuses.
        if (row.running === false) return result('failed', `${row.name} is not running. Open it first.`, { code: 'not-running' });
        if (row.running === null) return result('failed', `cannot tell whether ${row.name} is running: ${unknown}`, { code: 'unknown' });
        if (row.frontmost === true) return result('done', `${row.name} is already frontmost.`, { running: true, frontmost: true });
      }
      if (!launcher) return result('refused', 'no app launcher on this host: opening apps needs macOS.', { code: 'unsupported' });
      if (dryRun) return dry([openCommand(row.bundleId)]);
      const done = await (verb === 'open' ? launcher.open(row.bundleId) : launcher.activate(row.bundleId));
      return done.ok ? result('done', verb === 'open' ? `asked macOS to open ${row.name}.` : `raised ${row.name}.`, { running: true, ...(verb === 'focus' ? { frontmost: true } : {}) })
        : result('failed', done.error, { code: 'failed' });
    }

    // Prefer the bundle id when the file has one; the adapter matches it exactly.
    // Opening may skip the app list only with no desktop connection at all and an explicit bundle id in the
    // allowlist file. A connected desktop whose list errors (KILL, pause, no grant) and a name-only entry still refuse.
    const control = makeControl(verb === 'open' && deps.call === undefined && allowed.bundleId !== null);
    let resolvedQuitApp: RunningApp | null = null;
    if (isQuit) {
      const live = await control.list();
      if (!live.ok) return result('failed', 'cannot verify the live app identity before quitting.', { code: 'failed' });
      const lookup = (allowed.bundleId ?? allowed.name).toLowerCase();
      resolvedQuitApp = live.apps.find(app => app.bundleId?.toLowerCase() === lookup)
        ?? live.apps.find(app => app.name.toLowerCase() === lookup)
        ?? null;
      const resolvedBrowser = ownerBrowserQuitReason(resolvedQuitApp?.name, resolvedQuitApp?.bundleId);
      if (resolvedBrowser) return result('refused', resolvedBrowser, { code: 'protected' });
      const protectedApp = resolvedQuitApp ? protectedLiveApp(resolvedQuitApp) : undefined;
      if (protectedApp) return result('refused', protectedQuitReason(protectedApp), { code: 'protected' });
      // The app in front is the one the owner is using right now: never quit it.
      if (resolvedQuitApp?.frontmost) return result('refused', `${resolvedQuitApp.name} is in front, and Phantom never quits the app you are using. Switch to another app first.`, { code: 'focused' });
    }
    const reopen = verb === 'restart' ? resolvedQuitApp?.bundleId ?? allowed.bundleId : null;
    if (verb === 'restart' && !reopen) return result('failed', `restart needs ${allowed.name}'s bundle id to open it again.`, { code: 'unsupported' });
    if (verb === 'restart' && !launcher) return result('refused', 'no app launcher on this host: restarting apps needs macOS.', { code: 'unsupported' });
    if (dryRun) {
      const steps = [
        ...(resolvedQuitApp ? [`press Quit in ${resolvedQuitApp.name}'s menu (computer_ax_press) after an unsaved-work check, then wait up to ${QUIT_WAIT_MS / 1000} s for it to close`] : []),
        ...(reopen ? [openCommand(reopen)] : !isQuit && allowed.bundleId ? [openCommand(allowed.bundleId)] : []),
      ];
      return dry(steps, isQuit ? 'not running; nothing to quit.' : 'the bundle id is only known while the app runs.');
    }
    const res: AppControlResult = isQuit
      ? await control.quitResolved(resolvedQuitApp)
      : await control[verb as 'open' | 'focus' | 'status'](allowed.bundleId ?? allowed.name);
    if (res.ok && isQuit && resolvedQuitApp) {
      // Pressing Quit is a request, not proof. Watch the app list until it is gone or the budget runs out.
      const target = resolvedQuitApp;
      const waitMs = deps.quitWaitMs ?? QUIT_WAIT_MS;
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
      let gone = false;
      for (let waited = 0; ; waited += QUIT_POLL_MS) {
        const live = await control.list();
        gone = live.ok && !live.apps.some(a => target.bundleId ? a.bundleId === target.bundleId : a.name === target.name);
        if (gone || waited >= waitMs) break;
        await sleep(QUIT_POLL_MS);
      }
      if (!gone) return result('unknown', `asked ${target.name} to quit, but it had not closed after ${Math.round(waitMs / 1000)} s. Its state is unknown${verb === 'restart' ? ', so it was not reopened' : ''}.`, { code: 'quit-timeout' });
    }
    if (res.ok && reopen && launcher) {
      const opened = await launcher.open(reopen);
      return opened.ok ? result('done', `${resolvedQuitApp ? 'quit, then' : 'was not running;'} asked macOS to open ${allowed.name}.`, { running: true })
        : result('failed', `${allowed.name} quit, but did not reopen: ${opened.error}`, { code: 'failed' });
    }
    if (res.ok) return result('done', res.detail, { running: res.running, frontmost: res.frontmost });
    // Quit reads the app through Accessibility. When the desktop says that grant is missing, say so
    // with the one place to turn it on, rather than reporting possible unsaved work.
    if (isQuit && deps.call && (res.code === 'unreadable' || res.code === 'failed') && await accessibilityMissing(deps.call)) {
      return result('needs_permission', `Phantom needs Accessibility permission to quit ${allowed.name} safely. Turn Phantom on in ${ACCESSIBILITY_PANE}, then try again.`,
        { code: 'needs-permission', permission: { name: 'Accessibility', settingsPath: ACCESSIBILITY_PANE } });
    }
    if (isQuit && (res.code === 'unsaved-state' || res.code === 'unreadable')) {
      return queue('The app may have unsaved work. Save or discard in the app first.', res.code);
    }
    return result(res.code === 'denied' || res.code === 'unsupported' ? 'refused' : 'failed', res.error, { code: res.code });
  })();
  return { exit, report: emitted, text: humanText };
}
