/**
 * Fleet secrets custody record (design-custody-fleet.md section 3.3).
 *
 * One value-free record per engine spawn says whether the engine ran under
 * `phantom exec` and, if not, why. The reason is a closed list. Records hold
 * no paths, secret names, values or error strings.
 */
import { lstatSync } from 'node:fs';
import { basename, join } from 'node:path';

export const UNWRAPPED_REASONS = [
  'not-initialized',
  'phantom-not-installed',
  'phantom-disabled',
  'self-authenticating-engine',
  'worktree-namespace',
  'preflight-blocked',
  'preflight-unavailable',
  'connection-string-blocked',
  'unknown',
] as const;

export type UnwrappedReason = (typeof UNWRAPPED_REASONS)[number];

export type PhantomCustodyRecord =
  | { wrapped: true; engine: string; preflight_schema: 1; preflight_exit: number | null }
  | {
      wrapped: false;
      reason: UnwrappedReason;
      engine: string;
      preflight_schema: 1;
      preflight_exit: number | null;
    };

/** Engines that authenticate with their own login, never with project secrets. */
const SELF_AUTHENTICATING = new Set(['claude', 'codex']);

/** Engine name for the record: the binary basename, restricted to a safe charset. */
export function custodyEngineName(bin: string): string {
  const name = basename(bin).replace(/\.(exe|cmd)$/i, '');
  return /^[A-Za-z0-9._-]{1,64}$/.test(name) ? name : 'unknown';
}

/**
 * True when `cwd` is a linked git worktree (its `.git` is a file). Phantom
 * derives the vault namespace from the checkout path, so a linked worktree
 * opens a separate, empty vault until the opt-in source binding lands.
 * Never throws.
 */
export function isLinkedGitWorktree(cwd: string): boolean {
  try {
    return lstatSync(join(cwd, '.git')).isFile();
  } catch {
    return false;
  }
}

export interface PhantomCustodyInput {
  enabled: boolean;
  installed: boolean;
  initialized: boolean;
  linkedWorktree: boolean;
  engineBin: string;
  preflightExit?: number | null;
  /**
   * Strict preflight outcome (section 3.5), when one ran. Only `mayWrap: true`
   * keeps a wrap; anything else is recorded unwrapped with its reason.
   */
  preflight?: { mayWrap: boolean; reason?: 'preflight-blocked' | 'preflight-unavailable' };
}

export function decidePhantomCustody(input: PhantomCustodyInput): PhantomCustodyRecord {
  const engine = custodyEngineName(input.engineBin);
  const preflight_exit = input.preflightExit ?? null;
  const unwrapped = (reason: UnwrappedReason): PhantomCustodyRecord => ({
    wrapped: false,
    reason,
    engine,
    preflight_schema: 1,
    preflight_exit,
  });
  if (!input.enabled) return unwrapped('phantom-disabled');
  if (!input.installed) return unwrapped('phantom-not-installed');
  if (!input.initialized) {
    return unwrapped(SELF_AUTHENTICATING.has(engine) ? 'self-authenticating-engine' : 'not-initialized');
  }
  if (input.linkedWorktree) return unwrapped('worktree-namespace');
  if (input.preflight && !input.preflight.mayWrap) {
    return unwrapped(input.preflight.reason === 'preflight-blocked' ? 'preflight-blocked' : 'preflight-unavailable');
  }
  return { wrapped: true, engine, preflight_schema: 1, preflight_exit };
}

/** Coerce any value to a known reason; anything else is `unknown`, never wrapped. */
export function normalizeUnwrappedReason(value: unknown): UnwrappedReason {
  return (UNWRAPPED_REASONS as readonly unknown[]).includes(value) ? (value as UnwrappedReason) : 'unknown';
}

/** One stable stderr line for the record. */
export function formatCustodyLine(record: PhantomCustodyRecord): string {
  return `[ashlr] phantom custody ${JSON.stringify(record)}\n`;
}
