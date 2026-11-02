/**
 * `ashlr fleet self-tick-await` — wait for proof a NEW self-tick pass ran
 * (RQ-PHX-SELFTICKAWAIT02SOLE2; Nov 1 actually-running / unattended-restart
 * orders). An installed timer or stale last-run record is not evidence of
 * work: bounded read-only polling succeeds only on a recorded apply pass
 * strictly newer than --after. Never spawns, locks, writes or ticks.
 */
import { isAbsolute } from 'node:path';
import {
  awaitSelfTick, SELF_TICK_AWAIT_DEFAULT_INTERVAL_MS, SELF_TICK_AWAIT_MAX_INTERVAL_MS,
  SELF_TICK_AWAIT_MAX_TIMEOUT_MS, type SelfTickAwaitObservation,
  type SelfTickAwaitOptions, type SelfTickAwaitReport,
} from '../core/fleet/self-tick-await.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet self-tick-await --runs-dir <abs> --after <ISO> --timeout-ms <1..${SELF_TICK_AWAIT_MAX_TIMEOUT_MS}> [--interval-ms <1..${SELF_TICK_AWAIT_MAX_INTERVAL_MS}>] [--json]
Wait for proof a new self-tick pass ran: read-only polling of the existing
queue/self-tick-last.json under --runs-dir. Succeeds only when a record
strictly newer than --after (and not future-dated against this clock) has
mode=apply, state=ran and no failed steps; a new failed apply run names its
failed steps. Old, dry-run, busy, missing and unreadable records never count;
nothing is spawned, locked, written or ticked. --interval-ms defaults to
${SELF_TICK_AWAIT_DEFAULT_INTERVAL_MS}. Exit 0 succeeded, 1 failed, 2 usage,
3 timed out, 130 interrupted.`;

interface Dependencies {
  output?: (text: string) => void; error?: (text: string) => void;
  now?: SelfTickAwaitOptions['now']; read?: SelfTickAwaitOptions['read'];
  sleep?: SelfTickAwaitOptions['sleep']; signal?: AbortSignal;
}

/** The escaped, home-scrubbed spelling of one value for human output. */
const safe = (value: unknown): string => JSON.stringify(sanitizePublicJson(value))
  .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const describeObservation = (obs: SelfTickAwaitObservation | null): string =>
  obs === null ? 'nothing read yet' : obs.state === 'missing' ? 'no recorded run'
  : obs.state === 'unreadable' ? 'record unreadable'
  : `run ${safe(obs.at)} ${obs.mode}/${obs.ranState} failed=${obs.failedSteps.map(safe).join(',') || 'none'}`
    + (obs.futureDated ? ' (future-dated — not evidence)' : obs.newerThanAfter ? '' : ' (not newer than --after)');

function human(report: SelfTickAwaitReport): string {
  const waited = `waited ${report.waitedMs}ms, ${report.polls} poll(s)`;
  const last = `last observation: ${describeObservation(report.lastObservation)}`;
  const seen = report.lastObservation?.state === 'seen' ? report.lastObservation : null;
  switch (report.outcome) {
    case 'succeeded': return `fleet self-tick-await: SUCCEEDED — apply run at ${safe(seen?.at)} completed, no failed steps (${waited})`;
    case 'failed': return `fleet self-tick-await: FAILED — apply run at ${safe(seen?.at)} failed steps: ${seen!.failedSteps.map(safe).join(', ') || 'unknown'} (${waited})`;
    case 'timed-out': return `fleet self-tick-await: TIMED-OUT — no new completed apply run by deadline ${safe(report.deadlineAt)} (${waited}); ${last}`;
    case 'interrupted': return `fleet self-tick-await: INTERRUPTED — stopped before the deadline (${waited}); ${last}`;
  }
}

export async function cmdFleetSelfTickAwait(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }

  // Strict parse first: any unknown, duplicate or malformed argument exits 2
  // before a single record read happens.
  let json = false;
  let runsDir: string | undefined, afterRaw: string | undefined;
  let timeoutMs: number | undefined, intervalMs = SELF_TICK_AWAIT_DEFAULT_INTERVAL_MS;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return invalid();
    seen.add(arg);
    if (arg === '--json') { json = true; continue; }
    const value = args[++i];
    if (typeof value !== 'string' || value.startsWith('--')) return invalid();
    if (arg === '--runs-dir') { if (!isAbsolute(value)) return invalid(); runsDir = value; }
    else if (arg === '--after') { if (!Number.isFinite(Date.parse(value))) return invalid(); afterRaw = value; }
    else if (arg === '--timeout-ms' || arg === '--interval-ms') {
      if (!/^\d+$/.test(value)) return invalid();
      const n = Number(value);
      const max = arg === '--timeout-ms' ? SELF_TICK_AWAIT_MAX_TIMEOUT_MS : SELF_TICK_AWAIT_MAX_INTERVAL_MS;
      if (!Number.isSafeInteger(n) || n < 1 || n > max) return invalid();
      if (arg === '--timeout-ms') timeoutMs = n; else intervalMs = n;
    } else return invalid();
  }
  if (runsDir === undefined || afterRaw === undefined || timeoutMs === undefined) return invalid();

  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  deps.signal?.addEventListener('abort', interrupt, { once: true });
  if (deps.signal?.aborted) interrupt();
  try {
    const report = await awaitSelfTick({
      runsDir, afterMs: Date.parse(afterRaw), timeoutMs, intervalMs,
      signal: controller.signal,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.read === undefined ? {} : { read: deps.read }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });
    output(json ? JSON.stringify(sanitizePublicJson(report)) : human(report));
    return report.exitCode;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    deps.signal?.removeEventListener('abort', interrupt);
  }
}
