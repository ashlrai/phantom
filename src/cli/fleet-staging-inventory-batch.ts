import { isAbsolute, normalize } from 'node:path';
import { ELIGIBILITY, inventoryStaging } from '../core/fleet/staging-inventory.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = 'usage: ashlr fleet staging-inventory-batch --stdin [--json | --ndjson]';
const HELP = [USAGE, '',
  'A version-1 stdin JSON object describes roots for sequential scanning:',
  '  {"version":1,"roots":["/path/a","/path/b"]}',
  '',
  'Constraints: 1–8 absolute roots, no duplicates, UTF-8, ≤16KiB.',
  'Semantics: sequential read-only scan; partial-result exit codes',
  '(0 all-complete, 1 some-failed, 2 usage-invalid).',
  '',
  'Options: --json prints a single safe JSON report; --ndjson emits',
  '  per-root and summary lines to stdout.',
  '--help, -h  print this help and exit 0.',
].join('\n');
const MAX_BYTES = 16 * 1024;
type Input = AsyncIterable<Uint8Array | string> & { isTTY?: boolean };
type Report = Awaited<ReturnType<typeof inventoryStaging>>;
type Deps = {
  input?: Input;
  scanner?: (root: string) => Promise<Report>;
  output?: { log: (line: string) => void; error: (line: string) => void };
};

async function readRoots(input: Input): Promise<string[] | null> {
  if (input.isTTY) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BYTES) return null;
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length !== 2 || obj.version !== 1 || !Array.isArray(obj.roots)
    || obj.roots.length < 1 || obj.roots.length > 8) return null;
  const roots: string[] = [];
  for (const root of obj.roots) {
    if (typeof root !== 'string' || root.includes('\0') || !isAbsolute(root)) return null;
    const normalized = normalize(root);
    if (roots.includes(normalized)) return null;
    roots.push(normalized);
  }
  return roots;
}

export async function cmdFleetStagingInventoryBatch(args: string[], deps: Deps = {}): Promise<number> {
  const output = deps.output ?? console;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { output.log(HELP); return 0; }
  }
  const flags = new Set(args);
  if (flags.size !== args.length || !flags.has('--stdin') || (flags.has('--json') && flags.has('--ndjson')) || [...flags].some((flag) => !['--stdin', '--json', '--ndjson'].includes(flag))) {
    output.error(USAGE); return 2;
  }
  let roots: string[] | null;
  try { roots = await readRoots(deps.input ?? process.stdin); } catch { roots = null; }
  if (!roots) { output.error(USAGE); return 2; }
  const reports: (Report | { root: string; complete: false; source: 'failed'; cleanupEligibility: string })[] = [];
  let completed = 0;
  for (const [index, root] of roots.entries()) {
    let report: (typeof reports)[number];
    try { report = await (deps.scanner ?? inventoryStaging)(root); }
    catch { report = { root, complete: false, source: 'failed', cleanupEligibility: ELIGIBILITY }; }
    if (report.complete) completed++;
    if (flags.has('--ndjson')) {
      output.log(JSON.stringify(sanitizePublicJson({
        schema: 'fleet.staging-inventory-batch-progress.v1', index, requested: roots.length, report,
      })));
    } else reports.push(report);
  }
  if (flags.has('--ndjson')) {
    output.log(JSON.stringify(sanitizePublicJson({
      schema: 'fleet.staging-inventory-batch-summary.v1', requested: roots.length, completed,
      complete: completed === roots.length,
    })));
    return completed === roots.length ? 0 : 1;
  }
  const safe = sanitizePublicJson({ schema: 'fleet.staging-inventory-batch.v1', requested: roots.length, completed, reports }) as {
    schema: string; requested: number; completed: number; reports: typeof reports;
  };
  if (flags.has('--json')) output.log(JSON.stringify(safe));
  else {
    output.log(`Staging inventories: ${safe.completed}/${safe.requested} complete`);
    for (const report of safe.reports) output.log(`${JSON.stringify(report.root)}: ${report.complete ? 'complete' : 'incomplete'}; source: ${report.source}`);
    output.log(ELIGIBILITY);
  }
  return completed === roots.length ? 0 : 1;
}
