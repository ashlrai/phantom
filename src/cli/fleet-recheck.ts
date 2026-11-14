/** `ashlr fleet recheck` — one read-only verdict joining the runtime identity,
 * claims ledger, channel health and work board readers into four sections plus
 * an overall state. Text mode prints exactly five physical lines — RUNTIME,
 * CLAIMS, BRIDGE, TASK, OVERALL — each with as-of and source; every
 * interpolated value is flattened by safePhysicalLine, so observed evidence
 * can never add a line, move the cursor or forge a verdict. Exit 0 only when
 * every section is VERIFIED, 1 otherwise. Read-only: nothing is written, sent
 * or dispatched, and the verdict grants no authority. */
import { readFleetRecheck, type FleetRecheck, type FleetRecheckDeps } from '../core/fleet/fleet-recheck.js';
import { formatRecheckReply } from '../core/fleet/fleet-recheck-reply.js';

const usage = 'Usage: ashlr fleet recheck [--json|--reply]\n'
  + 'Prints one read-only verdict: RUNTIME|CLAIMS|BRIDGE|TASK|OVERALL lines with\n'
  + 'as-of and source, the fleet.recheck.v1 object with --json, or a short\n'
  + 'paste-ready thread reply with --reply (--reply and --json cannot combine).\n'
  + 'Exit 0 only when all four sections verify; 1 otherwise; 2 on bad arguments.\n'
  + '--reply always exits 0: the reply itself reports a BLOCKED or UNKNOWN verdict.';

function num(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

/* eslint-disable no-control-regex -- terminal escape sequences and control bytes must not reach the report. */
const ANSI_OSC = /(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C)/g;
const ANSI_CSI = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;
const ANSI_ESC = /\u001B[ -/]*[@-~]/g;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
/* eslint-enable no-control-regex */

/** Flatten one report line to a single safe physical line: OSC/CSI/ESC
 * terminal sequences removed, every line break, control and format character
 * folded to a space, printable Unicode kept. Applied to the assembled line so
 * an evidence string can never print a sixth line, erase the screen or forge
 * a section verdict; labels and states stay code-owned. */
function safePhysicalLine(text: string): string {
  return text
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_ESC, '')
    .replace(CONTROL_OR_FORMAT, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function line(label: string, state: string, asOf: string, source: string, detail: string): string {
  return safePhysicalLine(`${label} ${state} as-of=${asOf} source=${source} ${detail}`);
}

function textLines(recheck: FleetRecheck): string[] {
  const { runtime, claims, bridge, task } = recheck.sections;
  const channel = (name: 'slack' | 'imessage'): string => {
    const view = bridge.channels.find(c => c.channel === name);
    return `${name}=${view === undefined ? 'absent' : `${view.state}${view.runtimeHost === null ? '' : `@${view.runtimeHost}`}`}`;
  };
  const pick = task.task;
  return [
    line('RUNTIME', runtime.state, runtime.asOf, runtime.source,
      `host=${runtime.host} tailnet=${runtime.tailnetName} installed=${runtime.installedVersion} source-version=${runtime.sourceVersion} `
      + `fleet-state-age=${runtime.fleetState.ageSeconds} stale=${runtime.fleetState.stale} missing=${runtime.missing[0] ?? 'none'}`),
    line('CLAIMS', claims.state, claims.asOf, claims.source,
      `active=${num(claims.active)} expired=${num(claims.expiredClaims)} top=${claims.top.length} missing=${claims.missing[0] ?? 'none'}`),
    line('BRIDGE', bridge.state, bridge.asOf, bridge.source,
      `${channel('slack')} ${channel('imessage')} missing=${bridge.missingBridge ?? 'none'}`),
    line('TASK', task.state, task.asOf, task.source,
      `id=${pick?.id ?? 'none'} state=${pick?.state ?? 'none'} owner=${pick?.owner ?? 'none'} `
      + `claim=${pick?.claimReceipt ?? 'none'} missing=${task.missing[0] ?? 'none'}`),
    ...(task.lastVerified === undefined || task.lastVerified === null ? [] : [
      line('TASK', task.state, task.asOf, task.source,
        `last verified: ${task.lastVerified.id} owner=${task.lastVerified.owner} at ${task.lastVerified.asOf}`),
    ]),
    line('OVERALL', recheck.overall.state, recheck.asOf, 'fleet-recheck',
      `missing=${recheck.overall.missing.length} first=${recheck.overall.missing[0] ?? 'none'}`),
  ];
}

export async function cmdFleetRecheck(args: string[], deps: FleetRecheckDeps = {}): Promise<number> {
  let json = false;
  let reply = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json' && !json && !reply) { json = true; continue; }
    if (arg === '--reply' && !reply && !json) { reply = true; continue; }
    console.error(usage);
    return 2;
  }
  const recheck = await readFleetRecheck(deps);
  if (reply) { console.log(formatRecheckReply(recheck)); return 0; }
  if (json) console.log(JSON.stringify(recheck, null, 2));
  else for (const l of textLines(recheck)) console.log(l);
  return recheck.overall.state === 'VERIFIED' ? 0 : 1;
}
