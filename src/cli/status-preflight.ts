/**
 * Phantom preflight section of `phm status` (design-custody-fleet.md 3.5).
 *
 * Shows the same strict gate fleet spawns use (`phantom agent doctor --json
 * --strict`, plus `--vault` with ASHLR_PHANTOM_PREFLIGHT_VAULT=1), so an
 * operator can see before a run whether spawns will wrap or run unwrapped
 * with a preflight reason. Runs only when the gate is on
 * (ASHLR_PHANTOM_PREFLIGHT=1) and phantom is installed and configured;
 * otherwise returns null and status stays quiet and fast.
 * Value-free: verdict, exit code, booleans and kebab-case check ids only.
 */
import { getPhantomStatus } from '../core/phantom.js';
import {
  preflightVaultFromEnv,
  runPhantomPreflight,
  type PreflightRunner,
  type PreflightVerdict,
} from '../core/run/phantom-preflight.js';

export interface PreflightStatus {
  verdict: PreflightVerdict;
  exit: number | null;
  vaultProbed: boolean;
  /** What a fleet spawn here would do now: wrap with phantom exec, or run unwrapped. */
  spawn: 'wrap' | 'unwrapped';
  /** Custody reason recorded for an unwrapped spawn; null when spawns wrap. */
  reason: 'preflight-blocked' | 'preflight-unavailable' | null;
  checkIds: string[];
}

export interface PreflightStatusDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  runner?: PreflightRunner;
  phantom?: () => { installed: boolean; initialized: boolean };
}

const MAX_IDS = 8;

export function gatherPreflightStatus(deps: PreflightStatusDeps = {}): PreflightStatus | null {
  const env = deps.env ?? process.env;
  if (env['ASHLR_PHANTOM_PREFLIGHT'] !== '1') return null;
  const ph = (deps.phantom ?? getPhantomStatus)();
  if (!ph.installed || !ph.initialized) return null;
  const vault = preflightVaultFromEnv(env);
  const r = runPhantomPreflight(deps.cwd ?? process.cwd(), deps.runner, { vault });
  return {
    verdict: r.verdict,
    exit: r.exit,
    vaultProbed: vault,
    spawn: r.mayWrap ? 'wrap' : 'unwrapped',
    reason: r.mayWrap ? null : (r.reason ?? 'preflight-unavailable'),
    checkIds: r.checkIds.slice(0, MAX_IDS),
  };
}

export function formatPreflightStatusLine(s: PreflightStatus): string {
  const scope = s.vaultProbed ? 'with vault probe' : 'metadata only';
  const ids = s.checkIds.length ? ` [${s.checkIds.join(', ')}]` : '';
  const outcome = s.spawn === 'wrap' ? 'spawns wrap' : `spawns run unwrapped (${s.reason})`;
  return `${s.verdict} (exit ${s.exit ?? 'none'}, ${scope})${ids} · ${outcome}`;
}
