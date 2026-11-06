/**
 * planner-candidates.ts — the fleet's planner login slate.
 *
 * `<root>/queue/planner-candidates.json` is the ONLY place the fleet lists
 * the logins a planner pass may run on. Shape:
 *
 *   {
 *     "v": 1,
 *     "candidates": [{ "provider": "<login id>", "argv": ["<bin>", "..."] }],
 *     "lastProvider": "<login that produced the newest LEADER row>"
 *   }
 *
 * `candidates` is the priority order planPlannerPass walks — the first login
 * not proven usage-limited wins. `lastProvider` says which login the newest
 * health reading (planner-failover.ts) belongs to; that reading gates it and
 * no other candidate. `argv` is caller data carried for the runner — nothing
 * in this read executes it, and it never leaves the process in a route
 * response.
 *
 * The read is bounded (64 KB, no tail) and fail-soft: the file absent means
 * the fleet has no declared slate (`source: 'missing'`); the file present but
 * unreadable, over the bound, or malformed means the slate cannot be trusted
 * (`source: 'invalid'` — never a partial slate). Same conventions as the
 * failover reads: symlinks and non-files are refused by readSource.
 */
import { join } from 'node:path';
import { readSource } from './runs-parked-queue.js';
import type { PlannerCandidate } from './planner-failover.js';

export type PlannerCandidatesSource = 'ok' | 'missing' | 'invalid';
export interface PlannerCandidatesRead {
  source: PlannerCandidatesSource;
  /** The file this read looked at; kept for the console's missing-file line. */
  path: string;
  candidates: PlannerCandidate[];
  lastProvider: string | null;
}

export const PLANNER_CANDIDATES_FILE = join('queue', 'planner-candidates.json');
const MAX_CANDIDATES_BYTES = 64 * 1024;
const MAX_CANDIDATES = 64;
const MAX_PROVIDER_CHARS = 128;
const MAX_ARGV_ITEMS = 64;
const MAX_ARGV_CHARS = 1024;

const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

function parseCandidates(raw: unknown): PlannerCandidate[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_CANDIDATES) return null;
  const out: PlannerCandidate[] = [];
  for (const entry of raw) {
    if (!record(entry) || typeof entry['provider'] !== 'string' || entry['provider'].length === 0
      || entry['provider'].length > MAX_PROVIDER_CHARS || !Array.isArray(entry['argv'])
      || entry['argv'].length > MAX_ARGV_ITEMS
      || !entry['argv'].every((a: unknown) => typeof a === 'string' && a.length <= MAX_ARGV_CHARS)) return null;
    out.push({ provider: entry['provider'], argv: entry['argv'] as readonly string[] });
  }
  return out;
}

/** Read the planner slate. Never throws; never returns a partial file. */
export async function readPlannerCandidates(root: string): Promise<PlannerCandidatesRead> {
  const path = join(root, PLANNER_CANDIDATES_FILE);
  const empty = (source: PlannerCandidatesSource): PlannerCandidatesRead =>
    ({ source, path, candidates: [], lastProvider: null });
  const source = await readSource(path, MAX_CANDIDATES_BYTES, false);
  if (source.state === 'missing') return empty('missing');
  // 'degraded' covers unreadable, non-file and over the bound — the slate is
  // present but cannot be trusted, so it reads as invalid, not missing.
  if (source.state !== 'healthy') return empty('invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.text);
  } catch {
    return empty('invalid');
  }
  if (!record(parsed) || parsed['v'] !== 1) return empty('invalid');
  if (parsed['lastProvider'] !== undefined && typeof parsed['lastProvider'] !== 'string') return empty('invalid');
  const candidates = parseCandidates(parsed['candidates']);
  if (candidates === null) return empty('invalid');
  return { source: 'ok', path, candidates, lastProvider: (parsed['lastProvider'] as string | undefined) ?? null };
}
