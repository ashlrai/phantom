/** Read-only: what happened to each "- READY RQ-" bet in the leader's VISION.md. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FleetBetsReaders {
  /** Text of ~/.ashlr-runs/leader/VISION.md, or null when missing. */
  vision(): Promise<string | null>;
  /** The last `lines` lines of ~/.ashlr-runs/metrics/jobs.jsonl, or null when missing. */
  jobs(lines: number): Promise<string | null>;
}
export type BetStatus = 'not seen' | 'launched' | 'skipped' | 'PR open' | 'merged' | 'empty' | 'closed';
export interface Bet {
  id: string;
  status: BetStatus;
  asked_pool?: string;
  rerouted?: boolean;
  lane?: string;
  model?: string;
  precheck_code?: string | number;
  url?: string;
  ttm_s?: number;
}
export interface FleetBetsReport { schema: 'fleet.bets.v1'; merged: number; total: number; rerouted: number; bets: Bet[] }

const usage = 'Usage: ashlr fleet bets [--json]';
const TAIL = 3000;
const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
type Row = Record<string, unknown>;

/** Dates like 2026-11-03T10:00:00-0500 (no colon in the offset) are not portable to Date.parse. */
export function parseTs(value: unknown): number {
  if (typeof value !== 'string') return NaN;
  return Date.parse(value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/ (?=\d{2}:)/, 'T'));
}
const text = (v: unknown) => typeof v === 'string' && v ? v : undefined;
const seconds = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

export function readBets(vision: string | null, jobs: string | null): FleetBetsReport {
  const requested = new Map<string, string | undefined>();
  for (const line of (vision ?? '').split(/\r?\n/)) {
    const match = /^- READY (RQ-[A-Za-z0-9_-]+)/.exec(line);
    if (!match || requested.has(match[1]!)) continue;
    const metadata = /^\s*\(([^)]*)\)/.exec(line.slice(match[0].length));
    const pool = /(?:^|,\s*)pool=([A-Za-z0-9._-]+)(?=\s*(?:,|$))/.exec(metadata?.[1] ?? '');
    requested.set(match[1]!, pool?.[1]);
  }
  const ids = [...requested.keys()];
  const wanted = new Set(ids);
  // Per id, keep the newest row of each kind; a row with no usable ts counts as oldest.
  const latest = new Map<string, Map<string, { row: Row; at: number }>>();
  for (const line of (jobs ?? '').split(/\r?\n/).slice(-TAIL)) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Row, id = r.job ?? r.job_id ?? r.id, event = r.event;
    if (typeof id !== 'string' || !wanted.has(id) || typeof event !== 'string') continue;
    const at = parseTs(r.ts), byEvent = latest.get(id) ?? new Map();
    latest.set(id, byEvent);
    const old = byEvent.get(event);
    if (!old || (Number.isNaN(at) ? -Infinity : at) >= old.at) byEvent.set(event, { row: r, at: Number.isNaN(at) ? -Infinity : at });
  }
  const bets = ids.map((id): Bet => {
    const ev = latest.get(id), pick = (name: string) => ev?.get(name)?.row;
    const launch = pick('launch'), skip = pick('precheck_skip'), publish = pick('publish'), outcome = pick('outcome');
    const state = outcome?.state;
    const url = [outcome?.url, publish?.url].find((u): u is string => typeof u === 'string' && PR_URL.test(u));
    const bet: Bet = { id, status: 'not seen' };
    const askedPool = requested.get(id);
    if (askedPool) bet.asked_pool = askedPool;
    if (state === 'MERGED') {
      Object.assign(bet, { status: 'merged' }, url && { url }, seconds(outcome!.ttm_s) !== undefined && { ttm_s: outcome!.ttm_s });
    } else if (state === 'OPEN' || (url && state === undefined)) {
      Object.assign(bet, { status: 'PR open' }, url && { url });
    } else if (state === 'CLOSED') {
      Object.assign(bet, { status: 'closed' }, url && { url });
    } else if (state === 'EMPTY') {
      bet.status = 'empty';
    } else if (launch) {
      bet.status = 'launched';
    } else if (skip) {
      bet.status = 'skipped';
      const code = skip.code;
      if (typeof code === 'string' || typeof code === 'number') bet.precheck_code = code;
    }
    if (launch && bet.status !== 'skipped' && bet.status !== 'not seen') {
      const lane = text(launch.lane), model = text(launch.model);
      if (lane) {
        bet.lane = lane;
        if (askedPool && lane !== askedPool) bet.rerouted = true;
      }
      if (model) bet.model = model;
    }
    return bet;
  });
  return { schema: 'fleet.bets.v1', merged: bets.filter(b => b.status === 'merged').length, total: bets.length, rerouted: bets.filter(b => b.rerouted).length, bets };
}

const describe = (b: Bet): string => {
  const lane = b.lane && `${b.lane}${b.rerouted ? ` (asked ${b.asked_pool})` : ''}`;
  const via = [lane, b.model].filter(Boolean).join(', ');
  switch (b.status) {
    case 'launched': return via ? `launched (${via})` : 'launched';
    case 'skipped': return b.precheck_code === undefined ? 'skipped' : `skipped (precheck ${b.precheck_code})`;
    case 'PR open': return b.url ? `PR open (${b.url})` : 'PR open';
    case 'merged': return b.ttm_s === undefined ? 'merged' : `merged (${b.ttm_s}s to merge)`;
    default: return b.status;
  }
};
export const formatBets = (r: FleetBetsReport): string =>
  [`merged ${r.merged} of ${r.total}`, ...r.bets.map(b => `${b.id}: ${describe(b)}${b.rerouted && b.status !== 'launched' ? ` via ${b.lane} (asked ${b.asked_pool})` : ''}`)].join('\n');

export function defaultFleetBetsReaders(root = join(homedir(), '.ashlr-runs')): FleetBetsReaders {
  const optional = async (path: string): Promise<string | null> => {
    try { return await readFile(join(root, path), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  return {
    vision: () => optional('leader/VISION.md'),
    jobs: async lines => {
      const all = await optional('metrics/jobs.jsonl');
      return all === null ? null : all.split(/\r?\n/).slice(-lines).join('\n');
    },
  };
}

export async function cmdFleetBets(args: string[], readers: FleetBetsReaders = defaultFleetBetsReaders()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nFor each "- READY RQ-" bet in leader/VISION.md, show where it got to: not seen, launched (lane, model), skipped (precheck code), PR open (url), merged (seconds to merge), empty or closed. Rerouted bets show the launch lane followed by (asked pool). JSON includes asked_pool, rerouted and a rerouted count. First line: merged n of m. Reads the last ${TAIL} lines of metrics/jobs.jsonl. Read-only.`);
    return 0;
  }
  if (args.length > 1 || args.some(arg => arg !== '--json')) { console.error(usage); return 2; }
  try {
    const report = readBets(await readers.vision(), await readers.jobs(TAIL));
    console.log(args.length ? JSON.stringify(report) : formatBets(report));
    return 0;
  } catch {
    console.error('Unable to read the leader vision or jobs ledger.');
    return 1;
  }
}
