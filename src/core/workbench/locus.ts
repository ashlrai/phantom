import { execFile } from 'node:child_process';

export interface WbLocusReading {
  v: 1;
  state: 'ok' | 'unknown';
  reason: 'unavailable' | 'invalid' | null;
  custody: 'pinned' | 'unpinned' | 'unhealthy' | null;
  sessionOk: boolean | null;
}

const unknown = (reason: 'unavailable' | 'invalid'): WbLocusReading =>
  ({ v: 1, state: 'unknown', reason, custody: null, sessionOk: null });

/** Only the documented credential-free feed is read; child output is never logged. */
export async function readWbLocus(
  run: () => Promise<string> = () => new Promise((resolve, reject) => {
    execFile('locus', ['fleet-feed', '--json'], { timeout: 5000, maxBuffer: 64 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  }),
): Promise<WbLocusReading> {
  let raw: string;
  try { raw = await run(); } catch { return unknown('unavailable'); }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown('invalid');
    const feed = value as Record<string, unknown>;
    if (feed.schema !== 'locus.fleet_feed.v1' || feed.kind !== 'locus_session' ||
        (feed.state !== 'pinned' && feed.state !== 'unpinned' && feed.state !== 'unhealthy') ||
        typeof feed.session_ok !== 'boolean' || feed.session_ok !== (feed.state === 'pinned')) return unknown('invalid');
    return { v: 1, state: 'ok', reason: null, custody: feed.state, sessionOk: feed.session_ok };
  } catch { return unknown('invalid'); }
}
