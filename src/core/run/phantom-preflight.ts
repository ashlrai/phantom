/**
 * Fleet preflight: `phantom agent doctor --json --strict`
 * (design-custody-fleet.md section 3.5, contract schema_version 1).
 *
 * Exit codes: 0 ready, 1 blocked, 2 degraded, 3 could not evaluate.
 * Anything else, a spawn error, a timeout or unparsable output means
 * "do not run unattended with secrets". The vault is never probed: no
 * `--vault` flag is passed unless a caller explicitly asks (doctor with
 * ASHLR_DOCTOR_PHANTOM_VAULT=1), so the spawn-time preflight stays metadata-only.
 */
import { spawnSync } from 'node:child_process';

export const PHANTOM_PREFLIGHT_ARGS = ['agent', 'doctor', '--json', '--strict'] as const;
export const PHANTOM_PREFLIGHT_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 256 * 1024;

export type PreflightVerdict = 'ready' | 'degraded' | 'blocked' | 'unavailable';

export interface PhantomPreflightResult {
  verdict: PreflightVerdict;
  /** Process exit code, or null when the process did not exit normally. */
  exit: number | null;
  /** True only for verdict `ready`. */
  mayWrap: boolean;
  /** Unwrapped reason for the custody record when mayWrap is false. */
  reason?: 'preflight-blocked' | 'preflight-unavailable';
  /** Value-free check ids reported by phantom (kebab-case only). */
  checkIds: string[];
}

export interface PreflightRunOutput {
  status: number | null;
  stdout: string;
  error?: unknown;
}

const EXIT_TO_VERDICT: Record<number, 'ready' | 'blocked' | 'degraded'> = { 0: 'ready', 1: 'blocked', 2: 'degraded' };
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * A check id segment is a word (letters only, up to 24) or a short token such
 * as `v2` or `0600` (up to 4). Longer alphanumeric runs look like key material
 * (`sk-live-<hex>`) and are dropped, so a hostile or buggy preflight cannot
 * smuggle a secret-shaped string into doctor output or logs.
 */
function isWordSegment(seg: string): boolean {
  return /^[a-z]{1,24}$/.test(seg) || /^[a-z0-9]{1,4}$/.test(seg);
}

function unavailable(exit: number | null): PhantomPreflightResult {
  return { verdict: 'unavailable', exit, mayWrap: false, reason: 'preflight-unavailable', checkIds: [] };
}

/** Pure interpretation of one preflight run. Never throws. */
export function interpretPhantomPreflight(run: PreflightRunOutput, opts: { vaultRequested?: boolean } = {}): PhantomPreflightResult {
  if (run.error || run.status === null) return unavailable(run.status ?? null);
  const byExit = EXIT_TO_VERDICT[run.status];
  if (!byExit) return unavailable(run.status);
  if (run.stdout.length > MAX_STDOUT_BYTES) return unavailable(run.status);
  let doc: unknown;
  try {
    doc = JSON.parse(run.stdout);
  } catch {
    return unavailable(run.status);
  }
  if (!doc || typeof doc !== 'object') return unavailable(run.status);
  const d = doc as Record<string, unknown>;
  if (d['schema_version'] !== 1 || d['kind'] !== 'phantom.agent.preflight') return unavailable(run.status);
  // The JSON verdict must agree with the exit code; disagreement is not trusted.
  if (d['verdict'] !== byExit) return unavailable(run.status);
  // vault_probed must match what was asked: false by default, true only for an explicit --vault run.
  if (d['vault_probed'] !== (opts.vaultRequested === true)) return unavailable(run.status);
  const checks = Array.isArray(d['checks']) ? d['checks'] : [];
  const checkIds = checks
    .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>)['id'] : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length <= 64 && KEBAB.test(id) && id.split('-').every(isWordSegment));
  if (byExit === 'ready') return { verdict: 'ready', exit: 0, mayWrap: true, checkIds };
  return { verdict: byExit, exit: run.status, mayWrap: false, reason: 'preflight-blocked', checkIds };
}

export type PreflightRunner = (bin: string, args: readonly string[], cwd: string) => PreflightRunOutput;

const defaultRunner: PreflightRunner = (bin, args, cwd) => {
  const r = spawnSync(bin, [...args], {
    cwd,
    encoding: 'utf8',
    timeout: PHANTOM_PREFLIGHT_TIMEOUT_MS,
    maxBuffer: MAX_STDOUT_BYTES + 1,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return { status: r.status, stdout: r.stdout ?? '', error: r.error };
};

/** Run the strict preflight in `cwd`. Never throws. */
export function runPhantomPreflight(
  cwd: string,
  runner: PreflightRunner = defaultRunner,
  opts: { vault?: boolean } = {},
): PhantomPreflightResult {
  try {
    const args = opts.vault === true ? [...PHANTOM_PREFLIGHT_ARGS, '--vault'] : PHANTOM_PREFLIGHT_ARGS;
    return interpretPhantomPreflight(runner('phantom', args, cwd), { vaultRequested: opts.vault === true });
  } catch {
    return unavailable(null);
  }
}
