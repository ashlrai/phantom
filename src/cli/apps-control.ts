import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { appendBusInbox } from '../core/fleet/bus-inbox.js';
import { scrubSecrets } from '../core/util/scrub.js';
import {
  createAppControl, type AppControlResult, type AppLauncher, type RunningApp, type ToolCall,
} from '../core/verse/desktop-adapters.js';
import { appendNeedsMasonLine } from './fleet-safari-import.js';

const usage = `Usage: phm apps list [--json]
       phm apps open|quit|focus|status <app> [--json]
  Manage desktop apps named in ~/.ashlr/apps-allow.json (empty by default).
  <app> is a name or bundle id from that file. Every action is logged to the feed.
  Quitting an app that may have unsaved work is sent to needs-you instead (exit 3).
  Exit: 0 done, 1 refused or failed, 2 usage, 3 routed to needs-you.`;

const VERBS = ['list', 'open', 'quit', 'focus', 'status'] as const;
type Verb = (typeof VERBS)[number];

export interface AllowedApp { name: string; bundleId: string | null }
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
      const { name, bundleId } = entry as Record<string, unknown>;
      if (typeof name !== 'string' || !NAME.test(name.trim()) || (bundleId !== undefined && (typeof bundleId !== 'string' || !BUNDLE.test(bundleId)))) {
        return { ok: false, error: 'apps-allow.json has a malformed entry.' };
      }
      apps.push({ name: name.trim(), bundleId: (bundleId as string | undefined) ?? null });
    } else return { ok: false, error: 'apps-allow.json has a malformed entry.' };
  }
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
  launcher?: AppLauncher;
  allowFile?: string;
  /** Returns false when the entry could not be recorded. */
  feed?: (entry: AppsFeedEntry) => boolean;
  needsYou?: (text: string) => boolean;
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

interface Report {
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

export async function cmdApps(args: string[], deps: AppsControlDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  const json = args.includes('--json');
  const rest = args.filter((a, i) => !(a === '--json' && args.indexOf('--json') === i));
  const verb = rest[0] as Verb | undefined;
  const target = rest[1];
  if (!verb || !VERBS.includes(verb) || (verb === 'list' ? rest.length !== 1 : rest.length !== 2 || !target || target.startsWith('-') || /\p{Cc}/u.test(target) || target.length > 200)) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }

  const allowFile = deps.allowFile ?? join(ashlrHome(), 'apps-allow.json');
  const allow = readAllowlist(allowFile);
  const feed = deps.feed ?? defaultFeed;
  const control = createAppControl(deps.call ?? notConnected, { launcher: deps.launcher });
  const emit = (report: unknown, human: string): void => out(json ? JSON.stringify(report) : human);

  if (!allow.ok) {
    emit({ ok: false, action: verb, outcome: 'failed', detail: allow.error, logged: false }, allow.error);
    return 1;
  }

  if (verb === 'list') {
    const started = feed({ phase: 'start', action: 'list', app: '*' });
    const live = await control.list();
    const running: RunningApp[] = live.ok ? live.apps : [];
    const rows = allow.apps.map((a) => {
      const hit = running.find((r) => (a.bundleId && r.bundleId?.toLowerCase() === a.bundleId.toLowerCase()) || r.name.toLowerCase() === a.name.toLowerCase());
      return { name: a.name, bundleId: a.bundleId, running: live.ok ? hit !== undefined : null, frontmost: live.ok ? hit?.frontmost ?? false : null };
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
  const finish = (report: Omit<Report, 'logged' | 'action' | 'app'>, resultLogged: boolean, human: string): void => {
    emit({ ...report, action: verb, app: label, logged: resultLogged }, human);
  };

  const started = feed({ phase: 'start', action: verb, app: label });
  const result = async (outcome: AppsOutcome, detail: string, extra: Partial<Report> = {}, exit = outcome === 'done' ? 0 : 1): Promise<number> => {
    const logged = feed({ phase: 'result', action: verb, app: label, outcome, detail }) && started;
    finish({ ok: outcome === 'done', outcome, detail, ...extra }, logged, `${label}: ${detail}`);
    return exit;
  };

  if (!started) return result('refused', 'the feed could not record this action, so it was not run.', { code: 'feed-unavailable' });
  if (!allowed) return result('refused', `not in ${allowFile}.`, { code: 'not-allowlisted' });

  // Prefer the bundle id when the file has one; the adapter matches it exactly.
  const res: AppControlResult = await control[verb](allowed.bundleId ?? allowed.name);
  if (res.ok) return result('done', res.detail, { running: res.running, frontmost: res.frontmost });
  if (verb === 'quit' && (res.code === 'unsaved-state' || res.code === 'unreadable')) {
    const queued = (deps.needsYou ?? defaultNeedsYou)(oneLine(`Quit ${label}: it may have unsaved work. Save or discard in the app, then run phm apps quit ${label}.`));
    return result('needs-you', `${res.error} Sent to needs-you${queued ? '' : ' (the ledger write failed)'}.`, { code: res.code }, 3);
  }
  return result(res.code === 'denied' || res.code === 'unsupported' ? 'refused' : 'failed', res.error, { code: res.code });
}
