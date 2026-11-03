/** Read-only access to the fleet job metrics ledger, shared by the CLI and the verse API. */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_BYTES = 32 * 1024 * 1024;

export type JobsMetricsReader = () => Promise<string | null>;

/** Default reader: null when the file is missing, unreadable, not a file or too large. */
export const readJobsMetrics: JobsMetricsReader = async () => {
  const path = join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl');
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    return await readFile(path, 'utf8');
  } catch { return null; }
};
