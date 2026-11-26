/**
 * Why a lane with queued work and free slots launches nothing. Read-only:
 * `explainLaunchStall` is pure; `readLaunchStallFacts` builds facts from the
 * runs dir with the existing lane-console and lane-models parsers.
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseJobsJsonl, parseReadyTsv } from './lane-console.js';
import { parseJobLaunches } from './lane-models.js';

export const FLEET_LAUNCH_STALL_SCHEMA = 'fleet.launch-stall.v1';
/** A lane with free slots and queued work is stalled once its last launch is older than this. */
export const STALL_AFTER_MS = 20 * 60_000;
const HEAD_LINES = 3;
const MAX_BYTES = 8 * 1024 * 1024;

export interface LaunchStallFacts {
  lane: string;
  running?: number;
  target?: number;
  queued?: number;
  held: boolean;
  heldReason?: string;
  usageFrac?: number;
  usageResetAt?: string;
  lastLaunchAt?: string;
  lastMergeAt?: string;
  headLines: Array<{ id: string; blockedBy?: string }>;
}

export interface LaunchStallVerdict {
  lane: string;
  stalled: boolean;
  reasons: string[];
  firstAction: string;
}

export interface LaunchStallReport {
  schema: typeof FLEET_LAUNCH_STALL_SCHEMA;
  readOnly: true;
  lanes: LaunchStallVerdict[];
}

const ms = (iso: string | undefined): number | null => {
  const t = iso === undefined ? NaN : Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export function explainLaunchStall(facts: LaunchStallFacts, now: Date | number): LaunchStallVerdict {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const { lane, running, target, queued } = facts;
  const launchMs = ms(facts.lastLaunchAt);
  const countsKnown = running !== undefined && target !== undefined && queued !== undefined;
  const stalled = countsKnown && queued > 0 && running < target && (launchMs === null || nowMs - launchMs > STALL_AFTER_MS);
  const reasons: string[] = [];
  const missing: string[] = [];
  for (const [name, value] of [['running', running], ['target', target], ['queued', queued]] as const) {
    if (value === undefined) missing.push(name);
  }

  let action = '';
  if (facts.held) {
    reasons.push(`held: ${facts.heldReason ?? 'reason not recorded'}`);
    action = facts.heldReason
      ? `lane held: ${facts.heldReason}${facts.usageResetAt ? ` until ${facts.usageResetAt}` : ''}; nothing to do before then`
      : 'lane held with no recorded reason; the owner should find who set the hold';
  }
  if (facts.usageFrac !== undefined && facts.usageFrac >= 1) {
    reasons.push(`usage exhausted: ${Math.round(facts.usageFrac * 100)}% used, resets ${facts.usageResetAt ?? 'at an unknown time'}`);
    action ||= `usage exhausted until ${facts.usageResetAt ?? 'an unknown reset time'}; wait for the reset or move work to another lane`;
  } else if (facts.usageFrac === undefined) missing.push('usage');
  const heads = facts.headLines;
  if (heads.length > 0 && heads.every(h => h.blockedBy)) {
    const shown = heads.slice(0, HEAD_LINES).map(h => `${h.id} (${h.blockedBy})`).join(', ');
    reasons.push(`all ${heads.length} head lines blocked: ${shown}${heads.length > HEAD_LINES ? ', ...' : ''}`);
    action ||= `every head line is blocked, first ${heads[0]!.id} by ${heads[0]!.blockedBy}; clear that blocker or reorder the queue`;
  } else if (heads.length === 0 && (queued ?? 0) > 0) missing.push('head lines');
  if (launchMs === null) {
    if (facts.lastLaunchAt === undefined) missing.push('last launch');
    else reasons.push(`last launch time unreadable: ${facts.lastLaunchAt}`);
  } else if (stalled) reasons.push(`no launch since ${facts.lastLaunchAt} (${Math.floor((nowMs - launchMs) / 60_000)} min ago)`);
  if (missing.length > 0) reasons.push(`unknown (not assumed fine): ${missing.join(', ')}`);

  if (!stalled && !action) {
    action = !countsKnown ? 'lane counts are unknown; check queue/status.json'
      : queued === 0 ? 'no queued work for this lane; nothing is stalled'
        : running >= target ? 'lane is at target; nothing is stalled'
          : 'launched within 20 min; nothing is stalled';
  }
  action ||= reasons.length > 0 && !missing.length
    ? 'inspect the dispatcher log for this lane'
    : 'the dispatcher recorded no reason; read the lane\'s dispatch events and status.json';
  return { lane, stalled, reasons, firstAction: action };
}

async function readText(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch { return null; }
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
/** Parked rows wait on dependencies or holds; dispatchd skips them, so they never head the launch order. */
const PARKED_STATUS = /^PARKED(?:[.-]|$)/;
const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined;
const iso = (v: unknown): string | undefined => {
  const t = typeof v === 'number' ? v * 1000 : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};
const lanesOf = (text: string | null): Record<string, Record<string, unknown>> => {
  let raw: unknown;
  try { raw = text === null ? null : JSON.parse(text); } catch { return {}; }
  const map = rec(rec(raw)?.lanes) ?? rec(raw) ?? {};
  const out: Record<string, Record<string, unknown>> = Object.create(null);
  for (const [k, v] of Object.entries(map)) { const r = rec(v); if (r) out[k] = r; }
  return out;
};

/** Build facts for every lane in queue/status.json. Absent files leave facts undefined. */
export async function readLaunchStallFacts(runsDir = process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs')): Promise<LaunchStallFacts[]> {
  const queue = join(runsDir, 'queue');
  const [status, resources, ready, routerQueue, ledger, launchLog] = await Promise.all([
    readText(join(queue, 'status.json')), readText(join(queue, 'resources.json')),
    readText(join(queue, 'ready.tsv')), readText(join(queue, 'router-queue.md')),
    readText(join(queue, 'jobs.jsonl')),
    readText(join(runsDir, 'metrics', 'jobs.jsonl')),
  ]);
  const used = lanesOf(resources);
  const rows = ready === null ? [] : parseReadyTsv(ready, routerQueue).rows;
  const launches = launchLog === null ? null : parseJobLaunches(launchLog).latest;
  const merges = new Map<string, number>();
  for (const e of ledger === null ? [] : parseJobsJsonl(ledger).events) {
    const t = e.merge && e.pool && e.at ? Date.parse(e.at) : NaN;
    if (Number.isFinite(t) && t > (merges.get(e.pool!) ?? 0)) merges.set(e.pool!, t);
  }
  return Object.entries(lanesOf(status)).map(([lane, s]) => {
    const u = used[lane];
    const merge = merges.get(lane);
    return {
      lane, running: num(s.running), target: num(s.target), queued: num(s.queued),
      held: s.held === true, heldReason: str(s.held_reason),
      usageFrac: num(u?.used_frac), usageResetAt: iso(u?.reset_at),
      lastLaunchAt: launches?.get(lane)?.at ?? undefined,
      lastMergeAt: merge === undefined ? undefined : new Date(merge).toISOString(),
      // A ready row whose status is not READY is a blocked head line; its status is the blocker.
      // Parked rows are not launch candidates (dispatchd skips them and does not count them
      // in `queued`), so the head lines are the first non-parked rows in queue order.
      headLines: rows.filter(r => r.pool === lane && r.id && !PARKED_STATUS.test(r.status)).slice(0, HEAD_LINES)
        .map(r => ({ id: r.id!, ...(r.status !== 'READY' ? { blockedBy: r.status.toLowerCase() } : {}) })),
    };
  }).sort((a, b) => a.lane.localeCompare(b.lane));
}
