import { readFile } from 'node:fs/promises';
import { type MergedPullNote } from '../core/intent/evidence.js';
import { linkMergedPulls, noteMergedPulls } from '../core/intent/merge.js';
import { validRepo } from '../core/intent/schema.js';
import { readLedger } from '../core/intent/store.js';

const usage = 'Usage: ashlr fleet intent-merge-batch --input file [--apply] [--json]';
const MAX_INPUT = 1024 * 1024;
const MAX_PULLS = 1000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function parsePulls(value: unknown): MergedPullNote[] {
  if (!Array.isArray(value) || value.length > MAX_PULLS) throw new Error('Input must be an array of at most 1000 pulls.');
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid pull metadata.');
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).some((key) => !['repo', 'number', 'title', 'branch', 'url', 'at'].includes(key)) ||
      typeof row.repo !== 'string' || !validRepo(row.repo) || !Number.isSafeInteger(row.number) || (row.number as number) < 1 ||
      typeof row.title !== 'string' || !row.title.trim() || row.title.length > 4096 ||
      ['branch', 'url', 'at'].some((key) => row[key] !== undefined && (typeof row[key] !== 'string' || !(row[key] as string).trim() || (row[key] as string).length > 4096)) ||
      (typeof row.at === 'string' && (!ISO.test(row.at) || Number.isNaN(Date.parse(row.at))))) throw new Error('Invalid pull metadata.');
    return row as unknown as MergedPullNote;
  });
}

/** Record explicit metadata only; no network verification is performed. */
export async function cmdFleetIntentMergeBatch(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let input: string | undefined, apply = false, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input' && input === undefined && args[i + 1] && !args[i + 1]!.startsWith('--')) input = args[++i];
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--json' && !json) json = true;
    else { console.error(`error: invalid arguments\n${usage}`); return 2; }
  }
  if (!input) { console.error(`error: input is required\n${usage}`); return 2; }
  try {
    const data = await readFile(input);
    if (data.length > MAX_INPUT) throw new Error('Input exceeds 1 MiB.');
    const pulls = parsePulls(JSON.parse(data.toString('utf8')) as unknown);
    const now = new Date().toISOString();
    const result = apply ? await noteMergedPulls(pulls, { now }) : linkMergedPulls(await readLedger(), pulls, now);
    const output = { dryRun: !apply, applied: apply && result.updated > 0, ...result };
    console.log(json ? JSON.stringify(output) : `${output.applied ? 'Recorded' : 'Preview'}: ${output.updated} matched directive(s)`);
    return 0;
  } catch (error) {
    console.error(`intent-merge-batch: ${error instanceof Error ? error.message : 'operation failed'}`);
    return 1;
  }
}
