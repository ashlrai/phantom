/**
 * core/verse/slow-prs-api.ts — `GET /api/verse/fleet/slow-prs` (mounted by
 * verse-api.ts through the api-modules.ts contract).
 *
 * The same report `ashlr fleet slow-prs` prints (src/cli/fleet-slow-prs.ts):
 * PRs open at least 30 minutes, grouped per repo with their URLs, read from
 * the last 2 MiB of <runsDir>/metrics/jobs.jsonl.
 *
 *   GET  /api/verse/fleet/slow-prs   → { known: true, generatedAt, ...FleetSlowPrsReport }
 *   missing/unreadable ledger        → 200 { known: false, repos: [] }
 *   any query parameter              → 400 VERSE_INVALID
 *   any other method                 → 405
 *   any other path                   → false (next module runs)
 *
 * Read-only: no dispatch gate, no mutation surface. The response carries the
 * report fields only — never paths or error text.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { summarizeFleetSlowPrs, type FleetSlowPrsReader } from '../../cli/fleet-slow-prs.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_SLOW_PRS_PATH = '/api/verse/fleet/slow-prs';
const JOBS_LEDGER_TAIL_BYTES = 2 * 1024 * 1024;

/** Descriptor-bound tail read of the jobs ledger, like runs-history-api's readEventsTail. */
async function readJobsLedgerTail(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('not a file');
    if (info.size <= 0) return '';
    const start = Math.max(0, info.size - JOBS_LEDGER_TAIL_BYTES);
    const bytes = Buffer.alloc(Math.min(info.size, JOBS_LEDGER_TAIL_BYTES));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const text = bytes.subarray(0, offset).toString('utf8');
    return start ? text.slice(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n') + 1) : text;
  } finally { await file.close(); }
}

export function createSlowPrsApi(
  readJobs: FleetSlowPrsReader = readJobsLedgerTail,
  now: () => number = Date.now,
  runsDir = join(homedir(), '.ashlr-runs'),
): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_SLOW_PRS_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    const unknown = [...new URL(req.url ?? '/', 'http://localhost').searchParams.keys()][0];
    if (unknown !== undefined) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown parameter: ${unknown.slice(0, 64)}` });
      return true;
    }
    let text: string;
    try {
      text = await readJobs(join(runsDir, 'metrics', 'jobs.jsonl'));
    } catch {
      sendJson(res, 200, { known: false, repos: [] });
      return true;
    }
    sendJson(res, 200, { known: true, ...summarizeFleetSlowPrs(text), generatedAt: new Date(now()).toISOString() });
    return true;
  };
}

export const handleSlowPrsApi: ApiModule = createSlowPrsApi();
