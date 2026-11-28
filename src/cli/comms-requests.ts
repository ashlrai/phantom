/**
 * `phm comms requests` — the filtered read of the comms request ledger
 * (`~/.ashlr/comms/requests.jsonl`). `phm comms status` counts the live
 * queue and `phm comms inbox` lists only the pending/sent questions and
 * approvals still owed an answer; this is the only read that reaches
 * answered, expired and report rows — the ledger's full history, newest
 * first. Read-only: it sends nothing and mutates nothing.
 */
import { parseSince } from '../core/fleet/agent-messages.js';
import {
  COMMS_REQUESTS_CONTAINS_MAX,
  COMMS_REQUESTS_VIEW_LIMIT_DEFAULT,
  COMMS_REQUESTS_VIEW_LIMIT_MAX,
  readCommsRequestsView,
  type CommsRequest,
  type CommsRequestsQuery,
} from '../core/comms/requests.js';

const HELP = `usage: phm comms requests [--status <pending|sent|answered|expired>]... [--type <question|approval|report>]... [--kind <kind>] [--id <id>] [--since <15m|2h|1d|ISO|epoch-ms>] [--before <15m|2h|1d|ISO|epoch-ms>] [--contains <text>] [--limit <1..${COMMS_REQUESTS_VIEW_LIMIT_MAX}>] [--json]

Lists every comms request — questions, approvals and reports in each
lifecycle state — newest createdAt first. --status and --type may repeat
and combine as exact-match sets; --kind and --id are exact single matches.
--since keeps rows created at or after the cutoff and --before keeps rows
created strictly before it — the shared [since, before) window; a record
whose createdAt does not parse never matches a bounded window. --contains
keeps rows whose text, kind, options, recorded answer or expiry reason
carries the needle as a case-insensitive substring (whitespace collapsed
on both sides, up to ${COMMS_REQUESTS_CONTAINS_MAX} characters). --limit
caps the rows shown (default ${COMMS_REQUESTS_VIEW_LIMIT_DEFAULT}); the
JSON matched count still reports the full filter total. Exit 0 read, 1 an
unreadable store, 2 usage.`;

/** The `--kind`/`--id` value rule every label filter shares: a printable label, 1-128 chars. */
const LABEL = /^[\x21-\x7e]{1,128}$/;
const STATUSES = ['pending', 'sent', 'answered', 'expired'] as const;
const TYPES = ['question', 'approval', 'report'] as const;

type Options = { now?: () => number };

function invalid(message?: string): number {
  if (message !== undefined) console.error(message);
  console.error(HELP);
  return 2;
}

/** Human one-line description of an applied view filter, e.g. `status=sent type=question since=2026-11-07T11:45:00.000Z`. */
function describeQuery(query: CommsRequestsQuery | undefined): string {
  if (query === undefined) return '';
  return [
    ...(query.status === undefined ? [] : [`status=${query.status.join(',')}`]),
    ...(query.type === undefined ? [] : [`type=${query.type.join(',')}`]),
    ...(query.kind === undefined ? [] : [`kind=${query.kind}`]),
    ...(query.id === undefined ? [] : [`id=${query.id}`]),
    ...(query.sinceMs === undefined ? [] : [`since=${new Date(query.sinceMs).toISOString()}`]),
    ...(query.beforeMs === undefined ? [] : [`before=${new Date(query.beforeMs).toISOString()}`]),
    ...(query.contains === undefined ? [] : [`contains=${query.contains}`]),
  ].join(' ');
}

/** One ledger row as a scannable block: headline fields, then only the detail lines that carry real information. */
function printRequest(r: CommsRequest): void {
  const text = typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').trim() : '';
  const id = typeof r.id === 'string' ? r.id.slice(0, 8) : '?';
  const createdAt = typeof r.createdAt === 'string' ? r.createdAt : 'unknown';
  const kind = typeof r.kind === 'string' && r.kind !== '' ? r.kind : '?';
  const type = typeof r.type === 'string' ? r.type : '?';
  const status = typeof r.status === 'string' ? r.status : '?';
  console.log(`${createdAt}  ${status}  ${type}  ${kind}  ${id}  ${text === '' ? '(no text)' : text}`);
  const options = Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === 'string') : [];
  if (options.length > 0) console.log(`         options: ${options.map((o, i) => `${i + 1}. ${o}`).join('  ')}`);
  if (typeof r.sentAt === 'string') console.log(`         sent ${r.sentAt}`);
  if (r.status === 'answered') {
    const answer = typeof r.answerText === 'string' && r.answerText !== ''
      ? `"${r.answerText}"${typeof r.answerIndex === 'number' && r.answerIndex >= 0 ? ` (option ${r.answerIndex + 1})` : ''}`
      : typeof r.answerIndex === 'number' && r.answerIndex >= 0 ? `option ${r.answerIndex + 1}` : '(recorded)';
    console.log(`         answer: ${answer}${typeof r.answeredAt === 'string' ? ` at ${r.answeredAt}` : ''}`);
  }
  if (r.status === 'expired') {
    console.log(`         expired${typeof r.expiredAt === 'string' ? ` ${r.expiredAt}` : ''}${typeof r.expiredReason === 'string' && r.expiredReason !== '' ? ` — ${r.expiredReason}` : ''}`);
  }
}

function printView(view: ReturnType<typeof readCommsRequestsView>, query: CommsRequestsQuery | undefined): void {
  if (view.status === 'unavailable') {
    console.log('requests store unavailable — the ledger could not be read');
    return;
  }
  for (const r of view.requests) printRequest(r);
  const filter = describeQuery(query);
  const match = filter === '' ? '' : ` matching ${filter}`;
  if (view.matched === null || view.matched === 0) {
    console.log(filter === '' ? 'No requests.' : `No requests${match}.`);
    return;
  }
  const shown = view.requests.length;
  console.log(`${view.matched} request${view.matched === 1 ? '' : 's'}${match}${shown < view.matched ? ` — showing newest ${shown}` : ''}`);
}

export async function cmdCommsRequests(args: string[], options: Options = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(HELP);
    return 0;
  }
  const now = options.now ?? Date.now;
  const query: CommsRequestsQuery = {};
  const statuses = new Set<(typeof STATUSES)[number]>();
  const types = new Set<(typeof TYPES)[number]>();
  let limit = COMMS_REQUESTS_VIEW_LIMIT_DEFAULT;
  let json = false;
  const seen = new Set<string>();
  const takeValue = (i: number, flag: string): { value?: string; next?: number } => {
    const eq = flag.indexOf('=');
    if (eq >= 0) return { value: flag.slice(eq + 1), next: i };
    const value = args[i + 1];
    return { value, next: i + 1 };
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !seen.has(arg)) { seen.add(arg); json = true; continue; }
    if (arg === '--status' || arg.startsWith('--status=')) {
      const { value, next } = takeValue(i, arg);
      i = next!;
      if (value === undefined || value.startsWith('--') || !(STATUSES as readonly string[]).includes(value)) {
        return invalid('--status takes pending, sent, answered or expired.');
      }
      statuses.add(value as (typeof STATUSES)[number]);
      continue;
    }
    if (arg === '--type' || arg.startsWith('--type=')) {
      const { value, next } = takeValue(i, arg);
      i = next!;
      if (value === undefined || value.startsWith('--') || !(TYPES as readonly string[]).includes(value)) {
        return invalid('--type takes question, approval or report.');
      }
      types.add(value as (typeof TYPES)[number]);
      continue;
    }
    if (arg === '--kind' || arg === '--id' || arg === '--since' || arg === '--before' || arg === '--contains' || arg === '--limit' ||
      arg.startsWith('--kind=') || arg.startsWith('--id=') || arg.startsWith('--since=') || arg.startsWith('--before=') ||
      arg.startsWith('--contains=') || arg.startsWith('--limit=')) {
      const flag = arg.split('=')[0]!;
      if (seen.has(flag)) return invalid(`${flag} may be given once.`);
      seen.add(flag);
      const { value, next } = takeValue(i, arg);
      i = next!;
      if (value === undefined || value === '') return invalid(`${flag} needs a value.`);
      if (flag === '--kind' || flag === '--id') {
        // A flag-looking value is a missing label, not a kind or id — the same rule --job applies.
        if (value.startsWith('--') || !LABEL.test(value)) return invalid(`${flag} takes a printable label (1-128 chars).`);
        if (flag === '--kind') query.kind = value; else query.id = value;
      } else if (flag === '--since' || flag === '--before') {
        if (value.startsWith('--')) return invalid(`${flag} needs a value.`);
        const ms = parseSince(value, now());
        if (ms === null || !Number.isSafeInteger(ms) || ms < 0) {
          return invalid(`${flag} takes 15m, 2h, 1d, epoch ms or an ISO time.`);
        }
        if (flag === '--since') query.sinceMs = ms; else query.beforeMs = ms;
      } else if (flag === '--contains') {
        if (value.startsWith('--') || value.trim() === '' || value.length > COMMS_REQUESTS_CONTAINS_MAX) {
          return invalid(`--contains takes a non-empty search text of at most ${COMMS_REQUESTS_CONTAINS_MAX} characters.`);
        }
        query.contains = value;
      } else {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > COMMS_REQUESTS_VIEW_LIMIT_MAX) {
          return invalid(`--limit takes an integer from 1 to ${COMMS_REQUESTS_VIEW_LIMIT_MAX}.`);
        }
        limit = Number(value);
      }
      continue;
    }
    return invalid(`unknown option: ${arg}`);
  }
  if (statuses.size > 0) query.status = [...statuses];
  if (types.size > 0) query.type = [...types];
  const hasFilter = Object.keys(query).length > 0;
  const view = readCommsRequestsView(hasFilter ? query : undefined, limit);
  if (json) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      status: view.status,
      matched: view.matched,
      limit: view.limit,
      truncated: view.matched !== null && view.matched > view.requests.length,
      requests: view.requests,
    }));
  } else {
    printView(view, hasFilter ? query : undefined);
  }
  return view.status === 'unavailable' ? 1 : 0;
}
