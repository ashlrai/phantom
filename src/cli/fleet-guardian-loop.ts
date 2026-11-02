import { isAbsolute } from 'node:path';
import { GUARDIAN_DRAIN_MAX_RETRIES, type GuardianDrainDeps } from '../core/fleet/guardian-retry-drain.js';
import { drainWithFreshSession, repeatGuardianDrains, type GuardianRepeatDeps, type GuardianRepeatSummary } from '../core/fleet/guardian-repeat.js';
import { GUARDIAN_VERIFY_MAX_TIMEOUT_MS } from '../core/fleet/guardian-verify-loop.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

// `fleet guardian-loop` — repeat guardian-drain under one bounded command,
// carrying the last verified state forward. See core/fleet/guardian-repeat.ts.
// Const-arrow export: the shared subcommand registry generator only collects
// `export async function`, and the fleet convention loader finds this by name.
// Exit codes mirror guardian-drain: 0 done, 2 args, 3 unsafe/collision/
// cancelled/observer-error, 4 deadline, 5 refused.
const MAX_RECORD_BYTES = 8192;
const DAY_MS = 86_400_000;
const FLAGS = ['--manifest', '--source-state', '--output-dir', '--duration-ms', '--interval-ms', '--idle-backoff-max-ms', '--max-idle-passes', '--max-retries', '--max-passes', '--timeout-ms', '--stop-file'];

export const cmdFleetGuardianLoop = async (
  args: string[],
  deps: GuardianRepeatDeps & GuardianDrainDeps & { writeLine?: (line: string) => void | Promise<void> } = {},
): Promise<number> => {
  if (args.length === 1 && args[0] === '--help') {
    console.log('guardian-loop: --max-idle-passes N exits after N consecutive clean no-work passes (1..10000)');
    return 0;
  }
  const values: Record<string, string> = {};
  let json = false, stream = false, apply = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--stream' && !stream) { stream = true; continue; }
    if (flag === '--apply' && !apply) { apply = true; continue; }
    if (!FLAGS.includes(flag) || values[flag] !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write('error: invalid guardian-loop arguments\n'); return 2;
    }
    values[flag] = args[++i]!;
  }
  if (json && stream) { process.stderr.write('error: --json and --stream are mutually exclusive\n'); return 2; }
  const int = (v: string | undefined): number => v !== undefined && /^[1-9]\d*$/.test(v) ? Number(v) : NaN;
  const durationMs = int(values['--duration-ms']), intervalMs = int(values['--interval-ms']);
  const idleBackoffMaxMs = values['--idle-backoff-max-ms'] === undefined ? undefined : int(values['--idle-backoff-max-ms']);
  const maxIdlePasses = values['--max-idle-passes'] === undefined ? undefined : int(values['--max-idle-passes']);
  const maxRetries = int(values['--max-retries']), timeoutMs = int(values['--timeout-ms']);
  const maxPasses = values['--max-passes'] === undefined ? undefined : int(values['--max-passes']);
  const stopFile = values['--stop-file'];
  const path = (p: string | undefined): p is string => p !== undefined && isAbsolute(p) && p.length <= 4096 && !p.includes('\0');
  const [manifest, sourceState, outputDir] = [values['--manifest'], values['--source-state'], values['--output-dir']];
  if (!path(manifest) || !path(sourceState) || !path(outputDir) || (stopFile !== undefined && !path(stopFile))
    || !(durationMs <= DAY_MS) || !(intervalMs >= 1000 && intervalMs <= DAY_MS)
    || (idleBackoffMaxMs !== undefined && (!Number.isSafeInteger(idleBackoffMaxMs) || idleBackoffMaxMs < intervalMs || idleBackoffMaxMs > DAY_MS))
    || (maxPasses !== undefined && (!Number.isSafeInteger(maxPasses) || maxPasses < 1 || maxPasses > 1000))
    || (maxIdlePasses !== undefined && (!Number.isSafeInteger(maxIdlePasses) || maxIdlePasses < 1 || maxIdlePasses > 10000))
    || !(maxRetries <= GUARDIAN_DRAIN_MAX_RETRIES) || !(timeoutMs <= GUARDIAN_VERIFY_MAX_TIMEOUT_MS)) {
    process.stderr.write(`error: guardian-loop requires absolute --manifest/--source-state/--output-dir, --duration-ms 1..${DAY_MS}, --interval-ms 1000..${DAY_MS}, --max-retries 1..${GUARDIAN_DRAIN_MAX_RETRIES} and --timeout-ms 1..${GUARDIAN_VERIFY_MAX_TIMEOUT_MS}; optional --max-passes must be 1..1000, --max-idle-passes must be 1..10000, --idle-backoff-max-ms must be interval-ms..${DAY_MS} and --stop-file must be an absolute path
`);
    return 2;
  }
  const emit = async (record: unknown): Promise<void> => {
    let line = JSON.stringify(sanitizePublicJson(record));
    if (line.length > MAX_RECORD_BYTES) line = JSON.stringify({ record: (record as { record: string }).record, truncated: true });
    if (deps.writeLine) await deps.writeLine(`${line}\n`);
    else await new Promise<void>((resolve, reject) => process.stdout.write(`${line}\n`, e => e ? reject(e) : resolve()));
  };
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let summary: GuardianRepeatSummary;
  try {
    summary = await repeatGuardianDrains(
      { manifest, sourceState, outputDir, durationMs, intervalMs, idleBackoffMaxMs, maxPasses, maxIdlePasses, maxRetries, timeoutMs, apply, stopFile, signal: controller.signal },
      {
        now: deps.now, sleep: deps.sleep,
        drain: deps.drain ?? drainWithFreshSession(stream ? {
          ...deps,
          onAttempt: async attempt => {
            await deps.onAttempt?.(attempt);
            await emit({ record: 'attempt', ...attempt });
          },
        } : deps, deps.now),
        onPass: stream ? record => emit({ record: 'pass', ...record }) : undefined,
      },
    );
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
  if (stream) {
    try { await emit({ record: 'summary', ...summary }); } catch { return 3; }
  } else {
    const safe = sanitizePublicJson(summary) as GuardianRepeatSummary;
    console.log(json ? JSON.stringify(safe)
      : `guardian-loop: mode=${safe.mode} termination=${safe.termination} passes=${safe.passes} attempts=${safe.attempts} verified=${safe.verified} refused=${safe.refused}${safe.latestOutput ? ` latest=${safe.latestOutput}` : ''}${safe.session ? ` session=${safe.session}` : ''}`);
  }
  return summary.termination === 'deadline' ? 4 : summary.termination === 'refused' ? 5
    : ['unsafe', 'collision', 'cancelled', 'observer-error'].includes(summary.termination) ? 3 : 0;
};
