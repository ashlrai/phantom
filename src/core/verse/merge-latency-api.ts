/** Read-only merge wait report for the desktop Merges pane: how long PRs sit in
 * each stage, and which dropped auto-merges wait for a retry or a person.
 * The ledger path is fixed; nothing in the request picks it. */
import { join } from 'node:path';
import { fleetMergeLatency, readMergeEvents, type MergeEventReader, type MergeLatencyReport } from '../../cli/fleet-merge-latency.js';
import { fixedOwnerRunsDir } from '../comms/owner-channel.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_MERGE_LATENCY_PATH = '/api/verse/fleet/merge-latency';
const SCHEMA = 'verse.merge-latency.v1';
const DEFAULT_HOURS = 24;
const MAX_HOURS = 168;

export interface MergeLatencyApiDeps {
  /** Default: `<owner runs dir>/metrics/merge-events.jsonl`; neither env nor the request picks it. */
  ledgerPath?: string;
  now?: () => number;
  /** Reader seam for tests; receives the fixed path. */
  reader?: (path: string) => MergeEventReader;
}

/** 1..168, or null for anything that is not a plain integer in range. */
function parseHours(raw: string | null): number | null {
  if (raw === null) return DEFAULT_HOURS;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= MAX_HOURS ? value : null;
}

export function createMergeLatencyApi(deps: MergeLatencyApiDeps = {}): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_MERGE_LATENCY_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Merge latency is read only here.' });
      return true;
    }
    let hours: number | null;
    try {
      hours = parseHours(new URL(req.url ?? path, 'http://localhost').searchParams.get('hours'));
    } catch {
      hours = null;
    }
    if (hours === null) {
      sendJson(res, 400, { error: `hours must be an integer from 1 to ${MAX_HOURS}.` });
      return true;
    }
    const nowMs = (deps.now ?? Date.now)();
    const ledgerPath = deps.ledgerPath ?? join(fixedOwnerRunsDir(), 'metrics', 'merge-events.jsonl');
    const inner = (deps.reader ?? readMergeEvents)(ledgerPath);
    let present = false;
    const reader: MergeEventReader = async () => {
      const text = await inner();
      present = text !== null;
      return text;
    };
    let report: MergeLatencyReport;
    try {
      report = await fleetMergeLatency(reader, nowMs, hours);
    } catch {
      present = false;
      report = await fleetMergeLatency(async () => null, nowMs, hours);
    }
    sendJson(res, 200, { schema: SCHEMA, generatedAt: new Date(nowMs).toISOString(), ledger: present ? 'present' : 'missing', report });
    return true;
  };
}

export const handleMergeLatencyApi: ApiModule = createMergeLatencyApi();
