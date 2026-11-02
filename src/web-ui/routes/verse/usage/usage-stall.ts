/**
 * usage-stall.ts — detect a stalled usage meter (the percentage hasn't moved
 * while workers were running) so the desktop can surface an incident rather
 * than a false negative "everything is fine".
 */

export type UsageSample = {
  at: string | number;
  usedPct: number | null;
  workersRunning: number | null;
};

export type UsageStallResult = {
  stalled: boolean;
  unchangedMinutes: number | null;
  lastChangeAt: number | null;
  usedPct: number | null;
  workersSeen: number;
};

const EMPTY: UsageStallResult = {
  stalled: false,
  unchangedMinutes: null,
  lastChangeAt: null,
  usedPct: null,
  workersSeen: 0,
};

export function usageStall(
  samples: ReadonlyArray<UsageSample>,
  now: number,
  thresholdMinutes = 60,
): UsageStallResult {
  try {
    // Collect valid samples: parse `at` via Date.parse when string, drop
    // anything that can't be turned into a finite epoch, and drop entries
    // whose usedPct is null or non-finite.
    const valid: { t: number; pct: number; w: number }[] = [];

    for (const s of samples) {
      const t = typeof s.at === 'string' ? Date.parse(s.at) : s.at;
      if (!Number.isFinite(t)) continue;
      if (s.usedPct == null || !Number.isFinite(s.usedPct)) continue;
      valid.push({ t, pct: s.usedPct, w: s.workersRunning ?? 0 });
    }

    if (valid.length < 2) return EMPTY;

    // Sort ascending by time.
    valid.sort((a, b) => a.t - b.t);

    const newest = valid[valid.length - 1];
    const usedPct = newest.pct;

    // Walk backwards from the newest sample while the reading stays within
    // 0.05 of the newest value (the unchanged threshold).  Collect the
    // maximum workersRunning across the unchanged stretch.  `lastChangeAt`
    // is the epoch of the newest sample that *exceeds* 0.05, or null when
    // every sample is within the range.
    let lastChangeAt: number | null = null;
    let workersSeen = 0;
    let changed = false;

    for (let i = valid.length - 1; i >= 0; i--) {
      if (Math.abs(valid[i].pct - newest.pct) <= 0.05) {
        if (valid[i].w > workersSeen) workersSeen = valid[i].w;
      } else {
        lastChangeAt = valid[i].t;
        changed = true;
        break;
      }
    }

    let unchangedMinutes: number | null;

    if (!changed) {
      // All samples are within the threshold — the meter has been flat for
      // the full observation window.
      unchangedMinutes = Math.floor((now - valid[0].t) / 60_000);
    } else {
      // There is a real change point — measure only the unchanged tail.
      unchangedMinutes = Math.floor((now - lastChangeAt!) / 60_000);
    }

    const stalled =
      unchangedMinutes !== null &&
      unchangedMinutes >= thresholdMinutes &&
      workersSeen > 0;

    return { stalled, unchangedMinutes, lastChangeAt, usedPct, workersSeen };
  } catch {
    return EMPTY;
  }
}
