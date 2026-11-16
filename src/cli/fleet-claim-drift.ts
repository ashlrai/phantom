/** `ashlr fleet claim-drift` — one read-only verdict comparing the bus work
 * claims table against the coordination table it is dual-written to. Text
 * mode prints one line per drift row (bus-only, coord-only, owner-mismatch)
 * then a final `state: ...` line; every interpolated value is flattened by
 * safePhysicalLine so an observed id or owner can never add a line, move the
 * cursor or forge the verdict. --json prints the fleet.claim-drift.v1
 * object. Exit 0 for VERIFIED, 1 for DRIFT, 2 for UNKNOWN or bad arguments.
 * Read-only: nothing is locked, written or sent, and the verdict grants no
 * claim or dispatch authority. */
import {
  readClaimStoreDrift,
  type ClaimDriftDeps,
  type ClaimDriftRow,
  type ClaimStoreDrift,
} from '../core/fleet/claim-store-drift.js';

const usage = 'Usage: ashlr fleet claim-drift [--json]\n'
  + 'Prints one read-only verdict comparing live bus work claims with the\n'
  + 'coordination leases they are dual-written to: one line per drift row,\n'
  + 'then a final `state:` line, or the fleet.claim-drift.v1 object with\n'
  + '--json. Exit 0 for VERIFIED, 1 for DRIFT, 2 for UNKNOWN or bad arguments.\n'
  + 'Fencing tokens never appear in the output.';

/* eslint-disable no-control-regex -- terminal escape sequences and control bytes must not reach the report. */
const ANSI_OSC = /(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C)/g;
const ANSI_CSI = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;
const ANSI_ESC = /\u001B[ -/]*[@-~]/g;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
/* eslint-enable no-control-regex */

/** Flatten one report line to a single safe physical line: OSC/CSI/ESC
 * terminal sequences removed, every line break, control and format character
 * folded to a space, printable Unicode kept. Applied to the assembled line so
 * an observed owner or id can never print an extra line, erase the screen or
 * forge the state line; labels stay code-owned. */
function safePhysicalLine(text: string): string {
  return text
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_ESC, '')
    .replace(CONTROL_OR_FORMAT, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function rowLine(kind: string, row: ClaimDriftRow): string {
  const base = `${kind} id=${row.id} cursor=${row.cursor} received-at=${row.receivedAt} lease-until=${row.leaseUntil}`;
  if (kind === 'owner-mismatch') {
    return safePhysicalLine(`${base} bus-owner=${row.busOwner ?? row.owner} coord-owner=${row.coordOwner ?? 'unknown'}`);
  }
  const tail = kind === 'coord-only' ? ` source-id=${row.sourceId ?? 'unknown'}` : '';
  return safePhysicalLine(`${base} owner=${row.owner}${tail}`);
}

function textLines(drift: ClaimStoreDrift): string[] {
  const lines = [
    ...drift.busOnly.map(row => rowLine('bus-only', row)),
    ...drift.coordOnly.map(row => rowLine('coord-only', row)),
    ...drift.ownerMismatch.map(row => rowLine('owner-mismatch', row)),
  ];
  lines.push(safePhysicalLine(
    `state: ${drift.state}${drift.missing.length ? ` missing=${drift.missing.join(',')}` : ''}`,
  ));
  return lines;
}

export async function cmdFleetClaimDrift(args: string[], deps: ClaimDriftDeps = {}): Promise<number> {
  let json = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json' && !json) { json = true; continue; }
    console.error(usage);
    return 2;
  }
  const drift = readClaimStoreDrift(deps);
  if (json) console.log(JSON.stringify(drift, null, 2));
  else for (const line of textLines(drift)) console.log(line);
  return drift.state === 'VERIFIED' ? 0 : drift.state === 'DRIFT' ? 1 : 2;
}
