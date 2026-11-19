/**
 * App actions on the bus, in plain words. Every `phm apps <action>` run, and every app button in the console,
 * posts two envelopes from `apps-control` to mason: a `start` when it is accepted and a `result` when it ends
 * (core/apps-control.ts, `defaultFeed`). The two carry no shared id, so a result is paired with the oldest
 * unanswered start for the same action and app. Display only: nothing here grants or runs anything, and a fact
 * the envelopes do not hold reads as unknown.
 */
import type { AgentBusReceipt } from './agent-bus-queries.js';

/** Mirrors `APP_ACTIONS` plus the `list` verb in core/apps-control.ts. */
const VERBS = ['open', 'quit', 'focus', 'status', 'restart', 'list'] as const;
/** Mirrors `AppsOutcome` in core/apps-control.ts. */
const OUTCOMES = ['done', 'refused', 'failed', 'needs-you', 'needs_permission', 'unknown', 'dry-run'] as const;
export type AppVerb = (typeof VERBS)[number];
export type AppOutcome = (typeof OUTCOMES)[number];
/** `running`: started under a minute ago, no result yet. `unrecorded`: started, and no result ever arrived. */
export type AppActionState = AppOutcome | 'running' | 'unrecorded';

export interface AppActionEntry { phase: 'start' | 'result'; action: AppVerb; app: string; outcome: AppOutcome | null; detail: string }
export interface AppActionRow {
  key: string;
  /** When the result was recorded, or when the action started if none was. */
  at: string;
  action: AppVerb;
  app: string;
  state: AppActionState;
  detail: string;
  /** Start to result, when both envelopes were read. */
  tookMs: number | null;
}

/** A start with no result is "in progress" for this long (a quit may take 10 s), then "no result recorded". */
export const APP_ACTION_PENDING_MS = 60_000;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
// eslint-disable-next-line no-control-regex -- remove control bytes from untrusted display text.
const clean = (value: string, cap: number) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, cap);

/** The app action one envelope records, or null when it is any other message. */
export function appActionEntry(envelope: Pick<AgentBusReceipt['envelope'], 'from' | 'body'>): AppActionEntry | null {
  const body = record(envelope.body);
  if (envelope.from !== 'apps-control' || !body || body.kind !== 'apps-control') return null;
  const action = VERBS.find(verb => verb === body.action);
  const app = typeof body.app === 'string' ? clean(body.app, 120) : '';
  if ((body.phase !== 'start' && body.phase !== 'result') || !action || app === '') return null;
  // A result whose outcome this build does not know is still a result: say unknown rather than drop it.
  const outcome = body.phase === 'start' ? null : OUTCOMES.find(value => value === body.outcome) ?? 'unknown';
  return { phase: body.phase, action, app, outcome, detail: typeof body.detail === 'string' ? clean(body.detail, 160) : '' };
}

/** One row per app action, oldest first. */
export function appActionRows(receipts: readonly AgentBusReceipt[], nowMs: number): AppActionRow[] {
  const seen = new Set<string>();
  const open: { id: string; at: number; cursor: number; entry: AppActionEntry }[] = [];
  const rows: (AppActionRow & { atMs: number; cursor: number })[] = [];
  for (const { cursor, receivedAt, envelope } of [...receipts].sort((a, b) => a.cursor - b.cursor)) {
    const entry = seen.has(envelope.id) ? null : appActionEntry(envelope);
    if (!entry) continue;
    seen.add(envelope.id);
    if (entry.phase === 'start') { open.push({ id: envelope.id, at: receivedAt, cursor, entry }); continue; }
    const at = open.findIndex(start => start.entry.action === entry.action && start.entry.app === entry.app);
    const start = at < 0 ? null : open.splice(at, 1)[0]!;
    rows.push({ key: `app-${envelope.id}`, at: new Date(receivedAt).toISOString(), atMs: receivedAt, cursor, action: entry.action, app: entry.app,
      state: entry.outcome ?? 'unknown', detail: entry.detail, tookMs: start ? Math.max(0, receivedAt - start.at) : null });
  }
  for (const start of open) rows.push({ key: `app-${start.id}`, at: new Date(start.at).toISOString(), atMs: start.at, cursor: start.cursor,
    action: start.entry.action, app: start.entry.app, state: nowMs - start.at < APP_ACTION_PENDING_MS ? 'running' : 'unrecorded', detail: '', tookMs: null });
  return rows.sort((a, b) => a.atMs - b.atMs || a.cursor - b.cursor).map(({ atMs: _atMs, cursor: _cursor, ...row }) => row);
}

const VERB_WORD: Readonly<Record<AppVerb, string>> = { open: 'Open', quit: 'Quit', focus: 'Focus', status: 'Check', restart: 'Restart', list: 'List' };
const STATE_WORD: Readonly<Record<AppActionState, string>> = {
  done: 'done', refused: 'refused', failed: 'failed', 'needs-you': 'waiting for you', needs_permission: 'needs a macOS permission',
  unknown: 'result unknown', 'dry-run': 'dry run', running: 'in progress', unrecorded: 'no result recorded',
};

/** "Quit Slack"; the list verb has no single app. */
export function appActionTitle({ action, app }: Pick<AppActionRow, 'action' | 'app'>): string {
  return action === 'list' ? 'List allowed apps' : `${VERB_WORD[action]} ${app}`;
}
export const appActionStateWord = (state: AppActionState): string => STATE_WORD[state];
/** The states Mason has to act on. */
export const appActionWaitsOnYou = (state: AppActionState): boolean => state === 'needs-you' || state === 'needs_permission';
/** The states worth interrupting for: it did not happen, or nobody knows whether it did. */
export const appActionNeedsAttention = (state: AppActionState): boolean =>
  appActionWaitsOnYou(state) || state === 'refused' || state === 'failed' || state === 'unknown';
export function appActionTone(state: AppActionState): 'ok' | 'live' | 'warn' | 'bad' | 'unknown' {
  if (state === 'done' || state === 'dry-run') return 'ok';
  if (state === 'running') return 'live';
  if (appActionWaitsOnYou(state)) return 'warn';
  return state === 'refused' || state === 'failed' ? 'bad' : 'unknown';
}
/** "1.2 s", "340 ms"; an unpaired result has no duration. */
export function appActionTook(tookMs: number | null): string | null {
  if (tookMs === null) return null;
  return tookMs < 1000 ? `${Math.round(tookMs)} ms` : `${(tookMs / 1000).toFixed(tookMs < 10_000 ? 1 : 0)} s`;
}

/** One envelope as a single readable line, for lists that show envelopes one by one (the Bus pane). */
export function appActionEnvelopeSummary(envelope: Pick<AgentBusReceipt['envelope'], 'from' | 'body'>): { label: string; text: string } | null {
  const entry = appActionEntry(envelope);
  if (!entry) return null;
  const said = entry.outcome === null ? 'started' : STATE_WORD[entry.outcome];
  return { label: 'app action', text: `${appActionTitle(entry)}: ${said}${entry.detail ? `. ${entry.detail}` : ''}` };
}
