/** Explicit reset deadlines from usage-readings.log, without provider calls or global state. */
export interface PoolResetWindow {
  pool: string;
  resetAt: string;
  window: 'daily' | 'weekly';
}

// Require a timezone so the same log has the same meaning on every host.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseReading(line: string): PoolResetWindow | null {
  let value: unknown;
  if (line.startsWith('{')) {
    try { value = JSON.parse(line); } catch { return null; }
  } else {
    const fields: Record<string, string> = {};
    for (const field of line.split(/\s+/)) {
      const match = /^(pool|resetAt|window)=(\S+)$/.exec(field);
      if (!match) continue;
      const key = match[1]!;
      if (key in fields) return null;
      fields[key] = match[2]!;
    }
    value = fields;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { pool, resetAt, window } = value as Record<string, unknown>;
  if (typeof pool !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pool) ||
      typeof resetAt !== 'string' || !TIMESTAMP.test(resetAt) ||
      (window !== 'daily' && window !== 'weekly')) return null;
  const millis = Date.parse(resetAt);
  if (!Number.isFinite(millis)) return null;
  // Date.parse normalizes impossible calendar dates such as February 30.
  const day = resetAt.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return null;
  return { pool, resetAt: new Date(millis).toISOString(), window };
}

export interface PoolResetSchedule {
  readonly windows: readonly Readonly<PoolResetWindow>[];
  /** Fractional hours until the earliest future deadline, or null when unknown/elapsed. */
  hoursToReset(pool: string, now: Date | number): number | null;
}

/**
 * Parse JSONL objects or whitespace-delimited pool=... window=... resetAt=... lines.
 * Blank, missing and malformed readings are ignored. In append order, the last
 * valid reading for each pool/window wins. Elapsed deadlines are never rolled
 * forward: a reset is evidence, not a prediction of the next billing period.
 */
export function parseResetWindows(log: string): PoolResetSchedule {
  const latest = new Map<string, PoolResetWindow>();
  for (const raw of log.split(/\r?\n/)) {
    const reading = parseReading(raw.trim());
    if (reading) latest.set(`${reading.pool}/${reading.window}`, reading);
  }
  const windows = Object.freeze([...latest.values()].map((reading) => Object.freeze(reading)));
  return Object.freeze({
    windows,
    hoursToReset(pool: string, now: Date | number): number | null {
      const nowMs = now instanceof Date ? now.getTime() : now;
      if (!Number.isFinite(nowMs)) return null;
      let next = Infinity;
      for (const reading of windows) {
        const deadline = Date.parse(reading.resetAt);
        if (reading.pool === pool && deadline >= nowMs) next = Math.min(next, deadline);
      }
      return Number.isFinite(next) ? (next - nowMs) / 3_600_000 : null;
    },
  });
}
