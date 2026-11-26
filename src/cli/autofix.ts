/**
 * `phm autofix` - Eng Ops auto-fix for four host conditions.
 * Dry run unless --apply. Refuses when ~/.ashlr/KILL exists.
 * Logic lives in src/core/autofix/.
 */
import { collectSnapshot } from '../core/autofix/collect.js';
import { createNodeHost } from '../core/autofix/host-node.js';
import { runAutofix, fixerId } from '../core/autofix/run.js';
import {
  AUTOFIX_SCHEMA, FIXER_IDS,
  type AutofixHost, type AutofixSnapshot, type FixerId,
} from '../core/autofix/types.js';

const USAGE = [
  'usage: phm autofix [--apply] [--dry-run] [--json] [--only <fixer>] [--older-than <min>] [--stuck-minutes <min>]',
  `fixers: ${FIXER_IDS.join(', ')}`,
  'Dry run unless --apply. Refuses when ~/.ashlr/KILL exists.',
  'A hand edit of an installed pinned file is reported for Security and is not repaired.',
  'See docs/AUTOFIX.md.',
].join('\n');

export interface AutofixCliDeps {
  host?: AutofixHost;
  snapshot?: AutofixSnapshot;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  collect?: (host: AutofixHost) => Promise<AutofixSnapshot> | AutofixSnapshot;
}

export async function cmdAutofix(args: string[], deps: AutofixCliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((line) => console.log(line));
  const err = deps.stderr ?? ((line) => console.error(line));
  if (args.includes('--help') || args.includes('-h')) {
    out(USAGE);
    return 0;
  }
  const only: FixerId[] = [];
  let apply = false;
  let dry = false;
  let json = false;
  let stuckMinutes: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--apply') { apply = true; continue; }
    if (arg === '--dry-run') { dry = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--only' || arg === '--older-than' || arg === '--stuck-minutes') {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) {
        err(`error: ${arg} needs a value\n${USAGE}`);
        return 2;
      }
      if (arg === '--only') {
        const id = fixerId(value);
        if (!id || id === 'pinned-hand-edit') {
          err(`error: unknown fixer ${value}\n${USAGE}`);
          return 2;
        }
        only.push(id);
        continue;
      }
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 10080) {
        err(`error: ${arg} needs an integer from 1 to 10080`);
        return 2;
      }
      if (arg === '--stuck-minutes') stuckMinutes = Number(value);
      continue;
    }
    err(`error: unknown argument ${arg}\n${USAGE}`);
    return 2;
  }
  if (apply && dry) {
    err(`error: pass either --apply or --dry-run\n${USAGE}`);
    return 2;
  }
  const host = deps.host ?? createNodeHost();
  const snapshot = deps.snapshot ?? (deps.collect ? await deps.collect(host) : collectSnapshot(host));
  const result = await runAutofix({
    host, snapshot, dryRun: !apply, only, stuckMinutes,
  });
  if (json) {
    out(JSON.stringify({ schema: AUTOFIX_SCHEMA, dryRun: !apply, killed: result.killed, lines: result.lines, incidents: result.incidents }));
    return result.exitCode;
  }
  if (result.killed) {
    err('refused: ~/.ashlr/KILL exists');
    return result.exitCode;
  }
  out(!apply ? 'autofix dry run' : 'autofix apply');
  if (result.lines.length === 0) out('nothing to do');
  for (const line of result.lines) out(`${line.fixer} ${line.target}: ${line.result} ${line.action}`);
  return result.exitCode;
}
