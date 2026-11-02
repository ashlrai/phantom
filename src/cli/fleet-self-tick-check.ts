/**
 * `ashlr fleet self-tick-check` — read-only health probe for the host
 * self-management timer, for a supervisor (launchd/systemd/cron wrapper)
 * that needs a process exit STATUS, not a report. `fleet self-tick --last`
 * exits 0 even when nothing was ever recorded, so it cannot prove the timer
 * is running; this verb reads the same queue/self-tick-last.json record and
 * exits 0 ONLY for a readable, fresh, ran record with no failed steps that
 * also satisfies --require-apply when given. It never spawns, never takes a
 * lock, never runs a tick and never writes — one invocation changes nothing.
 *
 * Stable machine-readable reason codes (JSON field `reason`, human line
 * carries `reason=<code>`):
 *   ok         — healthy (exit 0)
 *   missing    — no recorded run (exit 1)
 *   unreadable — record file will not parse or fails validation (exit 1)
 *   future     — record timestamp is more than FUTURE_SKEW_SECONDS ahead of
 *                this clock; clock writeahead or a forged record must never
 *                count as fresh (ageSeconds is clamped at 0 by the reader,
 *                so `at` is re-checked against the injected now) (exit 1)
 *   stale      — ageSeconds exceeds --max-age-seconds (exit 1)
 *   busy       — the recorded run found the lock held and ran no step (exit 1)
 *   failed     — the recorded run has failed steps (exit 1)
 *   dry-run    — --require-apply was given but the recorded run was a
 *                dry-run (exit 1)
 * Usage errors exit 2. Exit codes: 0 healthy, 1 unhealthy, 2 usage.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readSelfTickLast } from '../core/fleet/self-tick-last.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet self-tick-check [--json] [--runs-dir <abs>] [--max-age-seconds <positive integer>] [--require-apply]
Read-only health check of the recorded fleet self-tick run, for a host
supervisor: exits 0 only for a readable record whose run started within
--max-age-seconds (default 1800) of now, whose state is 'ran', with no
failed steps, and — with --require-apply — whose mode was 'apply'. Exit 1
names one stable reason (missing, unreadable, future, stale, busy, failed,
dry-run); a timestamp more than 60s ahead of this clock is 'future', never
healthy. Never spawns, takes a lock, runs a tick or writes anything. Exit 0
healthy, 1 unhealthy, 2 usage.`;

/** A record `at` this far ahead of the injected clock is reported 'future'. */
const FUTURE_SKEW_SECONDS = 60;
const DEFAULT_MAX_AGE_SECONDS = 1800;

type Reason = 'ok' | 'missing' | 'unreadable' | 'future' | 'stale' | 'busy' | 'failed' | 'dry-run';

interface Dependencies {
  now?: () => number;
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Home override for tests; used only by the runs-dir fallback. */
  home?: string;
}

export async function cmdFleetSelfTickCheck(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  let json = false, requireApply = false;
  let runsDir: string | undefined, maxAgeSeconds: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--require-apply' && !requireApply) requireApply = true;
    else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else if (arg === '--max-age-seconds' && maxAgeSeconds === undefined) {
      const value = args[++i];
      const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 1) return invalid();
      maxAgeSeconds = parsed;
    } else return invalid();
  }
  const maxAge = maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  // Same fallback as self-tick itself, resolved once: ASHLR_RUNS_DIR, else
  // ~/.ashlr-runs. Only the last-run record is read from this root.
  const home = deps.home ?? homedir();
  const root = resolve(runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(home, '.ashlr-runs'));
  const nowMs = (deps.now ?? Date.now)();
  const view = readSelfTickLast(root, nowMs);

  let reason: Reason;
  let detail: string;
  if (view === null) {
    reason = 'missing';
    detail = 'no recorded self-tick run';
  } else if (view.state === 'unreadable') {
    reason = 'unreadable';
    detail = 'the recorded run will not parse or fails validation';
  } else if (Date.parse(view.at) - nowMs > FUTURE_SKEW_SECONDS * 1_000) {
    reason = 'future';
    detail = `recorded at ${view.at}, ${Math.floor((Date.parse(view.at) - nowMs) / 1_000)}s ahead of this clock`;
  } else if (view.ageSeconds > maxAge) {
    reason = 'stale';
    detail = `last run ${view.at} is ${view.ageSeconds}s old (> ${maxAge}s)`;
  } else if (view.ranState === 'busy') {
    reason = 'busy';
    detail = 'the recorded run found the self-tick lock held; no step ran';
  } else if (view.failedSteps.length > 0) {
    reason = 'failed';
    detail = `failed steps: ${view.failedSteps.join(',')}`;
  } else if (requireApply && view.mode === 'dry-run') {
    reason = 'dry-run';
    detail = 'the recorded run was a dry-run; --require-apply needs an apply pass';
  } else {
    reason = 'ok';
    detail = `last run ${view.at} (${Math.floor(view.ageSeconds / 60)}m ago) ${view.mode} failed=none`;
  }

  const report = {
    v: 1,
    healthy: reason === 'ok',
    reason,
    at: view !== null && view.state === 'ok' ? view.at : null,
    ageSeconds: view !== null && view.state === 'ok' ? view.ageSeconds : null,
    mode: view !== null && view.state === 'ok' ? view.mode : null,
    ranState: view !== null && view.state === 'ok' ? view.ranState : null,
    failedSteps: view !== null && view.state === 'ok' ? view.failedSteps : [],
    maxAgeSeconds: maxAge,
    requireApply,
  };
  output(json
    ? JSON.stringify(sanitizePublicJson(report))
    : `fleet self-tick-check: ${report.healthy ? 'healthy' : 'UNHEALTHY'} (${reason === 'ok' ? '' : `reason=${reason} `}${detail})`);
  return report.healthy ? 0 : 1;
}
