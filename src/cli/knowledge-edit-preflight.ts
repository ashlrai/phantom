import { dirname, resolve } from 'node:path';
import {
  sanitizeFleetEdits,
  type ChangelogFragmentSpec,
  type FleetFileEdit,
} from '../core/fleet/collision-free-edits.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const HELP = `Usage: phm knowledge edit-preflight --file <edits.json> [--json]

Check requested edits against Phantom's existing fleet shared-file policy.
Input is an owner-controlled regular JSON file of at most 16 MiB:
  {"edits":[{"path":"src/example.ts","content":"replacement text"}],
   "changelog":{"id":"job-123","kind":"fixed","entries":["Describe the fix"]}}
The edits array is required (at most 50,000 entries); content is a string of
at most 8 Mi characters, or null for deletion. Changelog is optional or null.
For diversion it needs an id (1-128 letters, digits, underscores or hyphens,
starting with a letter or digit), a kind (added, changed, fixed, removed,
security, docs, chore), and 1-32 nonempty single-line entries of at most 500
characters after cleanup. Invalid fragment values leave a changelog refused.

Output lists allowed paths, refusals with existing rules/reasons, and diverted
from/to paths. File bodies and fragment entries are never emitted. Exit 0 means
no policy refusals, 1 means a policy refusal, and 2 means invalid arguments or
input. This is advisory, writes nothing, grants no merge permission, and does
not replace the owner lane.
`;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inputShape(value: unknown): value is { edits: FleetFileEdit[]; changelog?: ChangelogFragmentSpec | null } {
  if (!isObject(value) || !Array.isArray(value.edits) ||
      Object.keys(value).some(key => key !== 'edits' && key !== 'changelog')) return false;
  const spec = value.changelog;
  if (spec === undefined || spec === null) return true;
  return isObject(spec) && typeof spec.id === 'string' && typeof spec.kind === 'string' &&
    Array.isArray(spec.entries) && spec.entries.every(entry => typeof entry === 'string') &&
    Object.keys(spec).every(key => ['id', 'kind', 'entries'].includes(key));
}

export async function runKnowledgeEditPreflight(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const invalid = (message: string): number => {
    process.stderr.write(`error: ${message}\n`);
    return 2;
  };
  let file: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--file' && file === undefined) {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('-')) return invalid('--file requires a path');
      file = value;
    } else return invalid('invalid edit-preflight arguments; see --help');
  }
  if (file === undefined) return invalid('--file is required');

  const absolute = resolve(file);
  const read = readStableRegularFile(absolute, {
    anchorPath: dirname(absolute), maxFileBytes: MAX_INPUT_BYTES, remainingBytes: MAX_INPUT_BYTES,
  });
  if (!read.ok) return invalid(`input file unavailable (${read.reason})`);
  let input: unknown;
  try { input = JSON.parse(read.text) as unknown; }
  catch { return invalid('input must be valid JSON'); }
  if (!inputShape(input)) return invalid('input must be an edits object with optional changelog metadata');

  let result: ReturnType<typeof sanitizeFleetEdits>;
  try { result = sanitizeFleetEdits(input.edits, { changelog: input.changelog }); }
  catch { return invalid('invalid fleet edit set'); }
  const report = {
    ok: result.ok,
    allowed: result.edits.map(edit => edit.path),
    refusals: result.refusals,
    diverted: result.diverted,
  };
  if (json) process.stdout.write(JSON.stringify(report) + '\n');
  else {
    process.stdout.write(`Edit preflight: ${report.ok ? 'ok' : 'refused'}\n`);
    for (const path of report.allowed) process.stdout.write(`  allowed: ${JSON.stringify(path)}\n`);
    for (const refusal of report.refusals) {
      process.stdout.write(`  refused: ${JSON.stringify(refusal.path)} [${refusal.rule}] ${refusal.why}` +
        (refusal.redirect ? ` (redirect: ${refusal.redirect})` : '') + '\n');
    }
    for (const diversion of report.diverted) {
      process.stdout.write(`  diverted: ${JSON.stringify(diversion.from)} -> ${JSON.stringify(diversion.to)}\n`);
    }
  }
  return result.ok ? 0 : 1;
}
