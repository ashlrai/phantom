/**
 * `ashlr fleet release-chain` — one read of where the desktop release chain
 * stopped and why (RQ-PHX-RELEASECHAINREAD85).
 *
 * While the installed app sat on 3.29.15, the v3.30.x line ended as 0-asset
 * drafts and each stall meant a human digging through
 * `~/.ashlr-runs/release-sign/` for lines like `rc=12, Desktop update
 * finalization held`. This verb answers it in one command: the newest
 * signing marker `release-sign/autorun/sha-<sha>.rc`, the `Reason:`/`held`
 * line of the newest signing log, the release version in that log's name,
 * and the installed app version read through the existing update-status
 * reader (src/core/app-update-status.ts, #4195).
 *
 * READ-ONLY: it only stats and reads files under the runs dir and reads the
 * installed bundle plist — nothing signs, publishes, or writes.
 * Exit codes: 0 the read ran (verdict is data, including `unknown`),
 * 2 bad usage.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readInstalledBundleVersion } from '../core/app-update-status.js';
import { readReleaseChainStatus, type ReleaseChainStatus } from '../core/fleet/release-chain-status.js';

export const FLEET_RELEASE_CHAIN_USAGE = 'ashlr fleet release-chain [--runs-dir DIR] [--json]';

export interface FleetReleaseChainDeps {
  /** Runs root; defaults to $ASHLR_RUNS_DIR then ~/.ashlr-runs. */
  runsDir?: string;
  /** Installed app version reader; defaults to readInstalledBundleVersion. */
  installedVersion?: () => string | null;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

function formatReleaseChain(status: ReleaseChainStatus): string {
  const run = status.latestAutorun;
  const lines = [run === null
    ? `${status.verdict}: no signing runs under release-sign/autorun`
    : `${status.verdict}: ${status.version === null ? 'version-unknown' : `v${status.version}`} rc=${run.rc ?? 'unreadable'} sha ${run.sha} at ${run.mtime}`];
  if (status.reason !== null) lines.push(status.reason);
  lines.push(`installed: ${status.installedVersion ?? 'unknown'}`);
  if (status.sources.length > 0) lines.push(`sources: ${status.sources.join('; ')}`);
  return lines.join('\n');
}

export async function cmdFleetReleaseChain(args: string[], deps: FleetReleaseChainDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  let json = false;
  let runsDir = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] === '-h' ? '--help' : args[i]!;
    if (arg === '--runs-dir' && !seen.has(arg) && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) {
      runsDir = args[++i]!;
    } else if ((arg === '--json' || arg === '--help') && !seen.has(arg)) {
      if (arg === '--json') json = true;
    } else {
      error(FLEET_RELEASE_CHAIN_USAGE);
      return 2;
    }
    seen.add(arg);
  }
  if (seen.has('--help')) { output(FLEET_RELEASE_CHAIN_USAGE); return 0; }
  let installed: string | null = null;
  try { installed = (deps.installedVersion ?? readInstalledBundleVersion)(); } catch { installed = null; }
  const status = readReleaseChainStatus({ runsDir, installedVersion: installed ?? undefined });
  output(json ? JSON.stringify(status) : formatReleaseChain(status));
  return 0;
}
