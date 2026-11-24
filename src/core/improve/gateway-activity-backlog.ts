/**
 * MCP gateway activity journal recurring policy blocks →
 * self-improvement backlog items.
 *
 * `phm mcp`'s gateway (src/core/mcp-gateway.ts) audits every tool call
 * its CallToolRequest handler serves: after the session check and the
 * native-tool fast path, checkGatewayPolicy (src/core/mcp-gateway-
 * policy.ts) may refuse the call, and audit() appends one
 * `{ts, session, caller, tool, verdict, args}` line to
 * `<account home>/gateway/activity.jsonl` through recordGatewayActivity
 * (src/core/gateway-sessions.ts). `verdict` is the writer's closed
 * vocabulary: 'allow' the call ran, 'deny' a policy rule refused it,
 * 'approval_required' a rule or ask_before_every_change gated it on
 * approval, 'revoked' the call arrived on a session whose record is
 * revoked or unreadable. `args` keeps argument NAMES only — every
 * value is the literal '[redacted]' — so the journal is safe to fold.
 * The file is append-only, self-trims at 8 MiB by dropping the oldest
 * rows and drops rows older than 14 days on the same pass.
 *
 * Until now the journal had no reader at all: readGatewayActivity's
 * only callers are the writer's own rotation and tests, so a (caller,
 * tool) pair the policy kept denying — an agent whose tool vocabulary
 * drifted onto refused names, or a legitimate need the policy never
 * learned — a tool whose approval gate kept stalling calls nobody
 * approved, and calls that kept arriving on revoked or unreadable
 * session records looked like isolated rows in a file nobody opened,
 * never a recurrence, never work. The activity log IS the gateway's
 * own record of which agent demands meet which policy verdicts, so
 * its recurring adverse cells are the toolchain's most direct evidence.
 *
 * gatewayActivityBacklogItems carries the same journal into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling fleet-evidence feeds
 * beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no lock, process
 *    or network is touched. A missing or unreadable file yields no
 *    items — unknown stays unknown, never a guessed tally — and a
 *    truncated tail folds the retained rows with the prompts stating
 *    the counts as lower bounds.
 *  - Rows count only under the writer's contract: a parseable `ts`, a
 *    `session` inside the writer's gs_<12 hex> id shape, a non-empty
 *    `caller` and `tool` string inside the writer's 80/160-char
 *    bounds, `verdict` inside the closed vocabulary, and `args` a
 *    plain object of at most the writer's 20 keys whose values are
 *    all the literal '[redacted]'. Malformed lines are counted,
 *    never guessed.
 *  - Only 'deny', 'approval_required' and 'revoked' rows are evidence:
 *    'allow' is the call running — the working vocabulary — and never
 *    emits.
 *  - Recurring means recorded across days at a rate that cannot be a
 *    transient burst: a cell emits only when its in-window records
 *    reach GATEWAY_ACTIVITY_MIN_UNITS across GATEWAY_ACTIVITY_MIN_DAYS
 *    distinct UTC days — a single refusal or a one-day burst stays
 *    quiet. The window is anchored on the clock with the sibling
 *    feeds' future-skew allowance, and a tail that dropped older rows
 *    still folds with lower-bound counts.
 *  - The evidence is this install's gateway journal: rows describe
 *    the agents and tools this machine's `phm mcp` served and carry
 *    no repository column, so items emit only when the backlog
 *    target's repository name is 'phantom', the same last-segment
 *    rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Item ids key on the cell — caller, tool and
 *    verdict — never the counts, sessions or timestamps, so a refresh
 *    re-derives the same ids and appendUserBacklogItems adds only
 *    what is new; a pair that recovers simply stops re-adding.
 *  - Every journal string is untrusted text: caller and tool names
 *    are scrubbed, flattened and capped before they reach a prompt,
 *    argument signatures quote key names only (values are already the
 *    '[redacted]' literal), and cell identity hashes the raw triple
 *    so journal text never becomes an identifier.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { activityLogPath, isGatewaySessionId } from '../gateway-sessions.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cap bounds the open-ended caller/tool cells. */
export const GATEWAY_ACTIVITY_BACKLOG_MAX_ITEMS = 12;
const GATEWAY_ACTIVITY_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const GATEWAY_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
const GATEWAY_ACTIVITY_FUTURE_SKEW_MS = 60_000;
/** In-window records a cell needs before its verdict counts as recurring. */
export const GATEWAY_ACTIVITY_MIN_UNITS = 3;
/** Distinct UTC days the records must span — recurring means recorded across days. */
export const GATEWAY_ACTIVITY_MIN_DAYS = 2;
/**
 * Bounded tail of the single activity journal. The writer self-trims at
 * 8 MiB (MAX_LOG_BYTES in gateway-sessions.ts, oldest rows dropped) and a
 * row runs a few hundred bytes, so 9 MiB reads every in-contract file
 * whole — `truncated` then means the file broke the writer's bound and
 * the fold states counts as lower bounds rather than guessing.
 */
export const GATEWAY_ACTIVITY_TAIL_BYTES = 9 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** The writer's contract bounds: caller is scrubbed and sliced to 80, tool to 160. */
const MAX_CALLER_CHARS = 80;
const MAX_TOOL_CHARS = 160;
/** The writer's contract: at most MAX_ARG_NAMES (20) keys, each scrubbed and sliced to 40 chars. */
const MAX_ARG_KEYS = 20;
const MAX_ARG_KEY_CHARS = 40;
/** Distinct argument signatures quoted inside one prompt before the rest is summarized. */
const PROMPT_SAMPLES_MAX = 4;
/** The fleet's own repository label: gateway evidence is this install's toolchain, never another target's. */
const FLEET_REPO_NAME = 'phantom';
const REDACTED = '[redacted]';

type CellKind = 'deny' | 'approval_required' | 'revoked';

export interface GatewayActivityItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Activity journal override (default: activityLogPath(), the writer's own resolver); tests only. */
  activityPath?: string;
  /** Most items one call emits (default GATEWAY_ACTIVITY_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default GATEWAY_ACTIVITY_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated activity row inside the evidence window. */
export interface GatewayActivityRow {
  atMs: number;
  utcDay: string;
  caller: string;
  tool: string;
  verdict: 'allow' | CellKind;
  /** Argument key names as recorded (values are always the '[redacted]' literal), sorted. */
  argKeys: string[];
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Pure: validate the writer's `args` contract — redactGatewayArgs emits a
 * plain object of at most 20 scrubbed key names (each ≤ 40 chars) mapped
 * to the literal '[redacted]'. Returns the sorted key names, or null when
 * the row is off-contract.
 */
function parseArgs(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > MAX_ARG_KEYS) return null;
  const names: string[] = [];
  for (const key of keys) {
    if (key.length > MAX_ARG_KEY_CHARS || value[key] !== REDACTED) return null;
    names.push(key);
  }
  return names.sort();
}

/**
 * Pure: validate one parsed journal line against the writer's entry
 * contract — the same fields recordGatewayActivity writes, plus a
 * parseable `ts` the fold needs for windowing. Anything else is not an
 * activity row.
 */
export function parseGatewayActivityEntry(value: unknown): GatewayActivityRow | null {
  if (!isRecord(value)) return null;
  const ts = value['ts'];
  const atMs = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const session = value['session'];
  if (typeof session !== 'string' || !isGatewaySessionId(session)) return null;
  const caller = value['caller'];
  if (typeof caller !== 'string' || caller.trim() === '' || caller.length > MAX_CALLER_CHARS) return null;
  const tool = value['tool'];
  if (typeof tool !== 'string' || tool.trim() === '' || tool.length > MAX_TOOL_CHARS) return null;
  const verdict = value['verdict'];
  if (verdict !== 'allow' && verdict !== 'deny' && verdict !== 'approval_required' && verdict !== 'revoked') return null;
  const argKeys = parseArgs(value['args']);
  if (argKeys === null) return null;
  return { atMs, utcDay: utcDayOf(atMs), caller: caller.trim(), tool: tool.trim(), verdict, argKeys };
}

/**
 * Pure: parse the journal's text into validated rows plus the count of
 * lines that were not on-contract entries — malformed JSON and
 * off-contract rows are counted, never guessed.
 */
export function parseGatewayActivityText(text: string): { rows: GatewayActivityRow[]; invalidRows: number } {
  const rows: GatewayActivityRow[] = [];
  let invalidRows = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      continue;
    }
    const row = parseGatewayActivityEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

/** One evidence cell's recurring tally across the in-window rows. */
interface GatewayActivityCell {
  kind: CellKind;
  /** The writer's caller identity exactly as recorded ('unknown' when ASHLR_MCP_AGENT was unset). */
  caller: string;
  /** The writer's tool name exactly as recorded. */
  tool: string;
  /** Records carrying this cell inside the window. */
  units: number;
  /** Distinct UTC days those records fall on. */
  days: Set<string>;
  /** Distinct argument signatures, capped at PROMPT_SAMPLES_MAX. */
  samples: string[];
  /** True when more distinct signatures existed than were kept. */
  sampleOverflow: boolean;
  firstAtMs: number;
  lastAtMs: number;
}

/** Journal-recorded strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

function argSignature(argKeys: readonly string[]): string {
  return argKeys.length === 0 ? 'no arguments' : argKeys.map((key) => fieldText(key, MAX_ARG_KEY_CHARS)).join(', ');
}

function cellFor(cells: Map<string, GatewayActivityCell>, caller: string, tool: string, kind: CellKind): GatewayActivityCell {
  const key = JSON.stringify([caller, tool, kind]);
  let cell = cells.get(key);
  if (cell === undefined) {
    cell = { kind, caller, tool, units: 0, days: new Set(), samples: [], sampleOverflow: false, firstAtMs: Infinity, lastAtMs: -Infinity };
    cells.set(key, cell);
  }
  return cell;
}

function addSample(cell: GatewayActivityCell, argKeys: readonly string[]): void {
  const cleaned = argSignature(argKeys);
  if (cleaned === '') return;
  if (cell.samples.includes(cleaned)) return;
  if (cell.samples.length >= PROMPT_SAMPLES_MAX) { cell.sampleOverflow = true; return; }
  cell.samples.push(cleaned);
}

function touch(cell: GatewayActivityCell, row: GatewayActivityRow): void {
  cell.units += 1;
  cell.days.add(row.utcDay);
  cell.firstAtMs = Math.min(cell.firstAtMs, row.atMs);
  cell.lastAtMs = Math.max(cell.lastAtMs, row.atMs);
}

/**
 * Pure: fold validated rows into per-(caller, tool, verdict) tallies.
 * Only the writer's adverse vocabulary counts — 'deny',
 * 'approval_required' and 'revoked' rows; 'allow' rows are the call
 * running and are context, never evidence.
 */
export function foldGatewayActivityEvidence(
  rows: readonly GatewayActivityRow[],
  opts: { nowMs: number; windowMs?: number },
): { cells: GatewayActivityCell[]; records: number; outsideWindow: number } {
  const windowMs = opts.windowMs ?? GATEWAY_ACTIVITY_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const cells = new Map<string, GatewayActivityCell>();
  let inWindow = 0;
  let outsideWindow = 0;
  for (const row of rows) {
    if (row.atMs < windowStart || row.atMs > opts.nowMs + GATEWAY_ACTIVITY_FUTURE_SKEW_MS) {
      outsideWindow += 1;
      continue;
    }
    inWindow += 1;
    if (row.verdict === 'allow') continue;
    const cell = cellFor(cells, row.caller, row.tool, row.verdict);
    touch(cell, row);
    addSample(cell, row.argKeys);
  }
  const recurring = [...cells.values()]
    .filter((cell) => cell.units >= GATEWAY_ACTIVITY_MIN_UNITS && cell.days.size >= GATEWAY_ACTIVITY_MIN_DAYS)
    .sort((a, b) => b.units - a.units || a.caller.localeCompare(b.caller) || a.tool.localeCompare(b.tool) || a.kind.localeCompare(b.kind));
  return { cells: recurring, records: inWindow, outsideWindow };
}

/** The evidence pointers every prompt shares; the journal, its writer and its policy module are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is <account home>/gateway/activity.jsonl — the writer\'s own path (activityLogPath() in src/core/gateway-sessions.ts resolves the account home via ashlrHome(), honoring $ASHLR_HOME, never the runs dir) — one append-only file the gateway self-trims at 8 MiB by dropping the oldest rows and prunes past 14 days. recordGatewayActivity is called only from the audit() closure inside startGateway\'s CallToolRequest handler in src/core/mcp-gateway.ts: after the session check (verdict \'revoked\' when the session record is revoked or unreadable) and the native-tool fast path (always \'allow\'), checkGatewayPolicy in src/core/mcp-gateway-policy.ts may return a block string recorded as \'approval_required\' or \'deny\'. The verdict row never names which policy rule fired — attributing a cell means reading the policy file (ASHLR_MCP_POLICY, parsed by loadGatewayPolicy/parseGatewayPolicy) and the caller\'s ASHLR_MCP_AGENT/ASHLR_MCP_GROUPS identity, then tracing which rule\'s tools entry or the ask_before_every_change flag produced the verdict. Its only readers until this feed were the writer\'s own 14-day/size rotation (rotateGatewayActivity, called on write and once at gateway start) and tests — the log was write-only evidence.';

const NO_CHANGE = 'If the window has rolled forward, the records were a one-off burst the later rows recovered from, the policy file is owner-pinned configuration this repo must not rewrite, or the refused calls come from agents or sessions outside this checkout — report no-change and name the evidence.';

function spanText(firstAtMs: number, lastAtMs: number): string {
  if (!Number.isFinite(firstAtMs) || !Number.isFinite(lastAtMs)) return '';
  const first = new Date(firstAtMs).toISOString();
  const last = new Date(lastAtMs).toISOString();
  return first === last ? ` Recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

function coverageNote(truncated: boolean, invalidRows: number, outsideWindow: number): string {
  const notes: string[] = [];
  if (truncated) notes.push('the bounded tail dropped older rows, so every count is a lower bound');
  if (invalidRows > 0) notes.push(`${invalidRows} malformed or off-contract lines dropped`);
  if (outsideWindow > 0) notes.push(`${outsideWindow} rows outside the window not counted`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function samplesText(cell: GatewayActivityCell): string {
  if (cell.samples.length === 0) return 'no argument signatures were recorded';
  const joined = cell.samples.map((s) => `'${s}'`).join(', ');
  return cell.sampleOverflow ? `${joined}, and more` : joined;
}

function cellCounts(cell: GatewayActivityCell): string {
  return `${cell.units} in-window records across ${cell.days.size} UTC days`;
}

function callerText(caller: string): string {
  return fieldText(caller, MAX_CALLER_CHARS) || 'unknown';
}

function toolText(tool: string): string {
  return fieldText(tool, MAX_TOOL_CHARS) || 'unknown';
}

const VERDICT_WORDS: Record<CellKind, { noun: string; lead: string }> = {
  deny: {
    noun: 'policy denials',
    lead: 'a policy rule refuses the call before it runs — checkGatewayPolicy returns a \'Policy <name>: deny\' block and the handler returns the refusal as a tool error',
  },
  approval_required: {
    noun: 'approval-gated calls',
    lead: 'a policy rule or the ask_before_every_change flag gates the call on approval — checkGatewayPolicy returns a \'Policy <name>: approval_required\' block and the handler returns the refusal as a tool error until an approval path clears it',
  },
  revoked: {
    noun: 'revoked-session calls',
    lead: 'the call arrived on a gateway session whose record reads revoked or cannot be read — isGatewaySessionAllowed fails closed and the handler refuses every call on that session id',
  },
};

function cellPrompt(cell: GatewayActivityCell, truncated: boolean, invalidRows: number, outsideWindow: number): string {
  const caller = callerText(cell.caller);
  const tool = toolText(cell.tool);
  const words = VERDICT_WORDS[cell.kind];
  return [
    `Phantom's MCP gateway keeps recording '${tool}' ${words.noun} for caller '${caller}' — ${cellCounts(cell)} inside the window, the self-improvement work this backlog exists for.`,
    '',
    `The gateway audits every tool call to <account home>/gateway/activity.jsonl with a closed verdict vocabulary; ${words.lead}. One refusal is a gate doing its job; recurrence across days means either the policy no longer matches what the fleet's agents legitimately need — a rule left at 'deny' or 'approval_required' after the workflow changed, ask_before_every_change set broader than the read-tool list intends, or a session record revoked while its gateway process still serves calls — or the callers keep attempting work the policy correctly forbids and their prompts or tool wiring need fixing.${spanText(cell.firstAtMs, cell.lastAtMs)} Recorded argument signatures (names only — values are never journaled): ${samplesText(cell)}.${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find which side is wrong: read the gateway policy in force (ASHLR_MCP_POLICY through loadGatewayPolicy, or the empty default policy), resolve the caller's identity (ASHLR_MCP_AGENT plus ASHLR_MCP_GROUPS at gateway start) and trace which rule or flag produces this verdict for '${tool}'. If the policy is owner-pinned configuration or the refused calls come from outside this checkout — report no-change and name the evidence; if a rule is stale relative to the fleet's actual needs, ask_before_every_change gates tools that are reads in practice, or revoked sessions keep serving calls because nothing retires the process — fix it in this repo's gateway policy handling, session lifecycle or the caller-facing guidance. ${NO_CHANGE}`,
  ].join('\n');
}

function cellTitle(cell: GatewayActivityCell): string {
  const caller = callerText(cell.caller);
  const tool = toolText(cell.tool);
  const words = VERDICT_WORDS[cell.kind];
  return `MCP gateway keeps recording '${tool}' ${words.noun} for '${caller}'`.slice(0, MAX_TITLE_CHARS);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

function gatewayActivityItem(cell: GatewayActivityCell, repo: string, truncated: boolean, invalidRows: number, outsideWindow: number): CloudBacklogItem {
  return {
    id: `gateway-activity-${sha(`gateway-activity:${cell.caller}:${cell.tool}:${cell.kind}`)}`,
    title: cellTitle(cell),
    prompt: cellPrompt(cell, truncated, invalidRows, outsideWindow),
    area: 'mcp-gateway',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the MCP gateway activity journal's recurring adverse
 * verdicts. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function gatewayActivityBacklogItems(opts: GatewayActivityItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const path = opts.activityPath ?? activityLogPath();
    if (typeof path !== 'string' || path === '') return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? GATEWAY_ACTIVITY_WINDOW_MS;
    const read = await readLedgerTail(path, GATEWAY_ACTIVITY_TAIL_BYTES);
    if (read.state !== 'read') return [];
    const parsed = parseGatewayActivityText(read.text);
    const folded = foldGatewayActivityEvidence(parsed.rows, { nowMs, windowMs });
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      items.push(gatewayActivityItem(cell, repo, read.truncated, parsed.invalidRows, folded.outsideWindow));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? GATEWAY_ACTIVITY_BACKLOG_MAX_ITEMS, GATEWAY_ACTIVITY_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
