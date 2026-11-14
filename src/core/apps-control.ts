import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from './cloud/store.js';
import { appendBusInbox } from './fleet/bus-inbox.js';
import { scrubSecrets } from './util/scrub.js';
import { defaultHostAppLauncher } from './verse/app-launcher.js';
import {
  createAppControl, type AppControlResult, type AppLauncher, type RunningApp, type ToolCall,
} from './verse/desktop-adapters.js';
import { appendNeedsMasonLine } from './fleet/needs-mason-append.js';
import { killSwitchOn } from './sandbox/policy.js';
import { isPaused } from './comms/pause.js';
import { computerAppPolicy } from './verse/computer-types.js';

export const APP_ACTIONS = ['open', 'quit', 'focus', 'status'] as const;
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

export type AppsOutcome = 'done' | 'refused' | 'failed' | 'needs-you';
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

export interface AppsActionReport {
  ok: boolean;
  action: Verb;
  app?: string;
  outcome: AppsOutcome;
  code?: string;
  detail: string;
  running?: boolean;
  frontmost?: boolean;
  logged: boolean;
}

export interface AppsListReport {
  ok: true; action: 'list'; allowFile: string;
  apps: Array<AllowedApp & { actions: AppAction[]; mode: 'direct' | 'request'; running: boolean | null; frontmost: boolean | null }>;
  connected: boolean; logged: boolean;
}
export type AppsReport = AppsActionReport | AppsListReport;
export interface AppsRequest { action: Verb; app?: string; request?: boolean }
const isSelf = (app: AllowedApp): boolean => app.name.toLowerCase() === 'phantom' || app.bundleId?.toLowerCase() === 'ai.ashlr.desktop';
const modeOf = (app: AllowedApp): 'direct' | 'request' => isSelf(app) ? 'request' : app.mode ?? 'direct';

/** Shared typed control surface. Neither console nor CLI owns an alternate execution path. */
export async function runAppsControl(input: AppsRequest, deps: AppsControlDeps = {}): Promise<{ exit: number; report: AppsReport; text: string }> {
  const { action: verb, app: target } = input;
  if ((verb !== 'list' && !APP_ACTIONS.includes(verb)) || (verb === 'list' ? target !== undefined || input.request === true : !target || target.startsWith('-') || /\p{Cc}/u.test(target) || target.length > 200) || (input.request === true && verb === 'status')) {
    return { exit: 2, report: { ok: false, action: verb, outcome: 'refused', code: 'invalid-request', detail: 'invalid app control request.', logged: false }, text: 'invalid app control request.' };
  }
  let emitted!: AppsReport;
  let humanText = '';
  const exit = await (async (): Promise<number> => {
    const allowFile = deps.allowFile ?? join(ashlrHome(), 'apps-allow.json');
    const allow = readAllowlist(allowFile);
    const feed = deps.feed ?? defaultFeed;
    const launcher = deps.launcher === null ? undefined : deps.launcher ?? (deps.call === undefined ? defaultHostAppLauncher() : undefined);
    const makeControl = (openWithoutList = false) => createAppControl(deps.call ?? notConnected, { launcher, openWithoutList });
    const emit = (report: AppsReport, human: string): void => { emitted = report; humanText = human; };

    if (!allow.ok) {
      emit({ ok: false, action: verb, outcome: 'failed', detail: allow.error, logged: false }, allow.error);
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
      emit({ ok: true, action: 'list', allowFile, apps: rows, connected: live.ok, logged },
        rows.length === 0 ? `No apps allowed. Add some to ${allowFile}.`
          : rows.map((r) => `${r.name}${r.bundleId ? ` (${r.bundleId})` : ''}: ${r.running === null ? 'unknown' : r.running ? `running${r.frontmost ? ', frontmost' : ''}` : 'not running'}`).join('\n'));
      return 0;
    }

    const requested = target!;
    const label = oneLine(requested);
    const allowed = allow.apps.find((a) => matches(a, requested));
    const finish = (report: Omit<AppsActionReport, 'logged' | 'action' | 'app'>, resultLogged: boolean, human: string): void => {
      emit({ ...report, action: verb, app: label, logged: resultLogged }, human);
    };

    const started = feed({ phase: 'start', action: verb, app: label });
    const result = async (outcome: AppsOutcome, detail: string, extra: Partial<AppsActionReport> = {}, exit = outcome === 'done' ? 0 : 1): Promise<number> => {
      detail = oneLine(detail);
      const logged = feed({ phase: 'result', action: verb, app: label, outcome, detail }) && started;
      finish({ ok: outcome === 'done', outcome, detail, ...extra }, logged, `${label}: ${detail}`);
      return exit;
    };

    if (!started) return result('refused', 'the feed could not record this action, so it was not run.', { code: 'feed-unavailable' });
    if (!allowed) return result('refused', `not in ${allowFile}.`, { code: 'not-allowlisted' });
    if (!(allowed.actions ?? APP_ACTIONS).includes(verb)) return result('refused', 'action is not allowed by this app policy.', { code: 'action-not-allowed' });
    if (verb !== 'status' && allowed.bundleId && !isSelf(allowed) && computerAppPolicy(allowed.bundleId).ceiling === null) return result('refused', 'that app is never available to agents.', { code: 'denied' });
    if (verb !== 'status' && (deps.writesBlocked ?? (() => killSwitchOn() || isPaused()))()) return result('refused', 'app writes are stopped by KILL or comms pause.', { code: 'writes-blocked' });
    const queue = async (reason: string, code: string): Promise<number> => {
      const queued = (deps.needsYou ?? defaultNeedsYou)(oneLine(`App request: ${verb} ${allowed.name}. ${reason} Recheck allowlist and app state before acting.`));
      return queued ? result('needs-you', `${reason} Sent to needs-you.`, { code }, 3)
        : result('failed', 'needs-you could not record this request; no action was run.', { code: 'needs-you-unavailable' });
    };
    if (verb !== 'status' && (input.request === true || modeOf(allowed) === 'request')) return queue('App-level action requested for review.', 'action-requested');

    // Prefer the bundle id when the file has one; the adapter matches it exactly.
    // Opening may skip the app list only with no desktop connection at all and an explicit bundle id in the
    // allowlist file. A connected desktop whose list errors (KILL, pause, no grant) and a name-only entry still refuse.
    const control = makeControl(verb === 'open' && deps.call === undefined && allowed.bundleId !== null);
    const res: AppControlResult = await control[verb](allowed.bundleId ?? allowed.name);
    if (res.ok) return result('done', res.detail, { running: res.running, frontmost: res.frontmost });
    if (verb === 'quit' && (res.code === 'unsaved-state' || res.code === 'unreadable')) {
      return queue('The app may have unsaved work. Save or discard in the app first.', res.code);
    }
    return result(res.code === 'denied' || res.code === 'unsupported' ? 'refused' : 'failed', res.error, { code: res.code });
  })();
  return { exit, report: emitted, text: humanText };
}
