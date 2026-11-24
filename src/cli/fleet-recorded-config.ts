/**
 * `ashlr fleet recorded-config --file <path> [--json]`: inspect one explicitly named
 * recorded scheduler config. Reads only that file. Never discovers HOME, reads auth or
 * session files, contacts providers or GitHub, writes state, dispatches, or changes config.
 * Results are recorded-input-only, not-current-availability, and no-policy-applied.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseRecordedSchedulerConfig, RecordedConfigError, type RecordedConfigInspection,
} from '../core/providers/coding-cli/recorded-config-inspection.js';

const usage = 'Usage: ashlr fleet recorded-config --file <path> [--json]';
/** Recorded configs are a few KB. Larger files are refused before reading. */
const MAX_BYTES = 1_000_000;

export interface FleetRecordedConfigDeps {
  /** Test seam. Defaults to reading the named file only. */
  readText?: (absolutePath: string) => string;
}

function parseArgs(args: string[]): { file: string; json: boolean } | null {
  let file: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--file' && file === undefined && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) {
      file = args[i + 1];
      i += 1;
    } else return null;
  }
  return file === undefined ? null : { file, json };
}

function describe(r: RecordedConfigInspection): string {
  const lines = [
    'Recorded scheduler config: recorded-input-only, not-current-availability, no-policy-applied.',
    `Attribution (supplied, not observed): ${r.provenance.suppliedSource ?? 'no source'}${r.provenance.suppliedSourceDate ? ` at ${r.provenance.suppliedSourceDate}` : ''}.`,
    `Supplied scalars: ${Object.keys(r.scalars).join(', ') || 'none'}. Unknown (not supplied): ${r.unsuppliedScalars.join(', ') || 'none'}.`,
    `Pools supplied: ${Object.keys(r.pools).join(', ') || 'none'}. Not supplied: ${r.unsuppliedPools.join(', ') || 'none'}.`,
  ];
  if (r.obsoleteReserve) {
    lines.push(`Obsolete reserve recorded: orchestrationReserveFraction ${r.obsoleteReserve.orchestrationReserveFraction}; automaticReserveApplied false.`);
  }
  return lines.join('\n');
}

export async function cmdFleetRecordedConfig(args: string[], deps: FleetRecordedConfigDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}\nInspect one recorded router scheduler config without applying it: supplied limits, unknown fields, and any recorded obsolete reserve (automaticReserveApplied:false). Reads only --file. Exit 2 on invalid arguments, 1 when the file is unreadable or invalid.`);
    return 0;
  }
  const parsed = parseArgs(args);
  if (!parsed) {
    console.error(`error: invalid fleet recorded-config arguments\n${usage}`);
    return 2;
  }
  let text: string;
  try {
    const absolute = resolve(parsed.file);
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('not a readable file');
    text = deps.readText ? deps.readText(absolute) : readFileSync(absolute, 'utf8');
  } catch {
    if (parsed.json) console.log(JSON.stringify({ error: 'unreadable-file', file: parsed.file }));
    else console.error(`error: fleet recorded-config could not read ${parsed.file}`);
    return 1;
  }
  let result: RecordedConfigInspection;
  try {
    result = parseRecordedSchedulerConfig(text);
  } catch (err) {
    if (!(err instanceof RecordedConfigError)) throw err;
    if (parsed.json) console.log(JSON.stringify({ error: 'invalid-recorded-config', path: err.path, message: err.message }));
    else console.error(`error: ${err.message}`);
    return 1;
  }
  console.log(parsed.json ? JSON.stringify(result) : describe(result));
  return 0;
}
