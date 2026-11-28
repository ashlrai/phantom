/**
 * Read-only org board. Recovered from ashlrai/phantom PR #5809 (head
 * 57bd29084a9359e13cad8a55db44fa43cb8aa2bd), src/core/org/agent-plane.ts: readAgentPlane and
 * orgBoardView only. The writers (proposeAgent, syncAgentPlane, writePlane) stay in the source PR.
 *
 * Contract: this module never creates, writes, or repairs storage. Absent storage is refused
 * (no randomly initialized board is synthesized), and every refusal is a fixed, bounded message
 * that never echoes file contents, paths, or exception text.
 */
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readStableRegularFile, type StableFileReadFailureReason } from '../util/stable-file-read.js';
import { metadata, planeSchema, validateChart, type OrgPlane } from './agent-plane-schema.js';

export const orgRunsRoot = (): string => process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');

/** Storage cap for org/agents.json, as in the source PR. */
export const ORG_STORE_MAX_BYTES = 4 * 1024 * 1024;

/** A refusal whose message is safe to show; any other thrown error is never shown. */
export class OrgStoreError extends Error {}

export function refuseOrgStore(message: string): never { throw new OrgStoreError(message); }

/** Safe operator-facing reason for org-plane CLI failures; never echoes unexpected errors. */
export function orgStoreErrorMessage(error: unknown, fallback: string): string {
  return error instanceof OrgStoreError ? error.message : fallback;
}

export interface OrgPlanePaths {
  anchor: string;
  dir: string;
  file: string;
  lockFile: string;
}

export function orgPlanePaths(root = orgRunsRoot()): OrgPlanePaths {
  const anchor = resolve(root);
  const dir = join(anchor, 'org');
  return { anchor, dir, file: join(dir, 'agents.json'), lockFile: join(dir, 'writer.lock') };
}

export function undeliveredLedgerEntries(plane: OrgPlane): OrgPlane['ledger'] {
  return plane.ledger.filter(row => !row.busDelivered);
}

export type OrgPlaneCliArgsResult =
  | { kind: 'help' }
  | { kind: 'usage' }
  | { kind: 'ok'; json: boolean; apply: boolean; runsDir: string | undefined };

/** Shared strict flag parser for `fleet org-board` and `fleet org-sync`. */
export function parseOrgPlaneCliArgs(
  args: readonly string[],
  options: { allowApply?: boolean } = {},
): OrgPlaneCliArgsResult {
  if (args.some(arg => arg === '--help' || arg === '-h')) return { kind: 'help' };
  let json = false;
  let apply = false;
  let runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (options.allowApply && arg === '--apply' && !apply) apply = true;
    else if (arg === '--runs-dir' && runsDir === undefined && next && !next.startsWith('--')) { runsDir = next; i++; }
    else return { kind: 'usage' };
  }
  return { kind: 'ok', json, apply, runsDir };
}

const READ_REFUSALS: Record<StableFileReadFailureReason, string> = {
  'unsafe-path': 'Org store refused: unsafe path.',
  'unsafe-file': 'Org store refused: unsafe file.',
  'per-file-byte-limit': 'Org store too large.',
  'byte-limit': 'Org store too large.',
  'changed-during-read': 'Org store unavailable.',
  'io-error': 'Org store unavailable.',
};

export function readAgentPlane(root = orgRunsRoot()): OrgPlane {
  const { anchor, file } = orgPlanePaths(root);
  let stat;
  try { stat = lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      refuseOrgStore('Org store absent: no persisted planning metadata; live staffing is unknown.');
    }
    refuseOrgStore('Org store unavailable.');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) refuseOrgStore('Org store refused: unsafe file.');
  if (stat.size > ORG_STORE_MAX_BYTES) refuseOrgStore('Org store too large.');

  // readStableRegularFile enforces containment by realpath, owner, mode, nlink=1, and stable identity.
  const read = readStableRegularFile(file, { anchorPath: anchor, maxFileBytes: ORG_STORE_MAX_BYTES, remainingBytes: ORG_STORE_MAX_BYTES });
  if (!read.ok) refuseOrgStore(READ_REFUSALS[read.reason]);

  let raw: unknown;
  try { raw = JSON.parse(read.text); } catch { refuseOrgStore('Invalid org store: malformed JSON.'); }
  let plane: OrgPlane;
  try {
    plane = metadata(planeSchema, raw);
    validateChart(plane.agents);
  } catch (error) {
    // Only this module's and the schema's fixed messages reach here; they never echo input.
    refuseOrgStore(`Invalid org store: ${(error instanceof Error ? error.message : 'validation failed').slice(0, 200)}`);
  }
  if (plane.revision !== plane.ledger.length || plane.ledger.some((entry, index) => entry.revision !== index + 1)) {
    refuseOrgStore('Invalid org ledger.');
  }
  return plane;
}

/** Board projection with the source PR's semantics; grantsExecutionAuthority is always false. */
export function orgBoardView(plane: OrgPlane) {
  return { schema: 'org.board.v1', revision: plane.revision, board: 'Mason', grantsExecutionAuthority: false,
    agents: plane.agents, pendingProposals: plane.ledger.filter(row => !row.applied),
    recentEdits: plane.ledger.filter(row => row.applied).slice(-20), pendingBusEvents: undeliveredLedgerEntries(plane).length };
}
