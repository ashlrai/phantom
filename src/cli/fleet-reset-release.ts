/**
 * `ashlr fleet reset-release` — headless one-shot of the guarded
 * reset-release primitive. The desktop's ops self-update GET arms the
 * in-process loop; this verb lets an agent run the same reconciliation once
 * without the desktop: with --apply it calls runResetReleaseOnce exactly
 * once, so the healthy-source gate and releaseLaneHold's per-lane guarded
 * recheck still apply and a hold a person placed is never released. Without
 * --apply it is a dry-run over readUsageResets + planResetReleases: no slots
 * write, no audit append, no timers, no HTTP or desktop initialization.
 */
import { isAbsolute } from 'node:path';
import {
  planResetReleases, runResetReleaseOnce, type ResetReleaseResult, type RunResetReleaseOptions,
} from '../core/fleet/usage-reset-release.js';
import { readUsageResets, type UsageResetRow, type UsageResetsV1 } from '../core/fleet/usage-reset-detect.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet reset-release [--json] [--runs-dir <abs>] [--apply]
Without --apply this is a dry-run: lanes whose autobackoff holds the evidence
would release are listed and nothing is written. --apply runs one
reconciliation pass through the guarded release path. Evidence that is not
healthy releases nothing; a manual hold is never released.`;

interface Dependencies {
  read?: RunResetReleaseOptions['read'];
  now?: () => number;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

/** The escaped, home-scrubbed spelling of one value for human output. */
const safe = (value: unknown): string => JSON.stringify(sanitizePublicJson(value))
  .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** The public subset of one planned lane — never hold reasons or raw provider rows. */
const publicRow = (row: UsageResetRow) => ({
  lane: row.lane, state: row.state, usedPct: row.usedPct, readingAsOf: row.readingAsOf, heldUntil: row.heldUntil,
});

export async function cmdFleetResetRelease(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  let json = false, apply = false, runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else return invalid();
  }
  const now = deps.now ?? Date.now;
  let resets: UsageResetsV1;
  let result: ResetReleaseResult | null = null;
  try {
    resets = await (deps.read ?? readUsageResets)({ runsDir, now });
    // One pass only, on the same snapshot the report shows: the source state
    // cannot drift between what the operator saw and what the run released.
    if (apply) result = await runResetReleaseOnce({ runsDir, now, read: async () => resets });
  } catch (err) {
    error(`fleet reset-release failed: ${safe(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
  const planned = planResetReleases(resets.rows);
  const payload = {
    v: 1,
    mode: apply ? 'apply' : 'dry-run',
    at: result?.at ?? resets.generatedAt,
    sourceState: resets.sourceState,
    checked: result?.checked ?? resets.rows.length,
    planned: planned.map(publicRow),
    released: result?.released ?? [],
    errors: result?.errors ?? [],
  };
  if (json) output(JSON.stringify(sanitizePublicJson(payload)));
  else {
    const lines = [`fleet reset-release: ${apply ? 'APPLIED' : 'DRY-RUN — no changes made'} · evidence ${payload.sourceState} · checked ${payload.checked} lane(s)`];
    if (!apply) {
      for (const row of planned) lines.push(`  ${safe(row.tell)}`);
      lines.push(planned.length ? `Run with --apply to release ${planned.length} lane(s).` : 'No releasable autobackoff holds.');
    } else {
      for (const row of payload.released) lines.push(`  released ${safe(row.lane)} (${row.state})`);
      for (const err of payload.errors) lines.push(`  error ${safe(err.lane)}: ${safe(err.message)}`);
      if (!payload.released.length && !payload.errors.length)
        lines.push(payload.sourceState === 'healthy' ? '  nothing to release' : '  holds kept — unhealthy evidence proves nothing');
    }
    output(lines.join('\n'));
  }
  return payload.sourceState === 'healthy' && payload.errors.length === 0 ? 0 : 1;
}
