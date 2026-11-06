import { isAbsolute, normalize } from 'node:path';
import { ELIGIBILITY, inventoryStaging } from '../core/fleet/staging-inventory.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = 'usage: ashlr fleet staging-inventory-batch --stdin [--json]';
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
  const flags = new Set(args);
  if (flags.size !== args.length || !flags.has('--stdin') || [...flags].some((flag) => !['--stdin', '--json'].includes(flag))) {
    output.error(USAGE); return 2;
  }
  let roots: string[] | null;
  try { roots = await readRoots(deps.input ?? process.stdin); } catch { roots = null; }
  if (!roots) { output.error(USAGE); return 2; }
  const reports: (Report | { root: string; complete: false; source: 'failed'; cleanupEligibility: string })[] = [];
  for (const root of roots) {
    try { reports.push(await (deps.scanner ?? inventoryStaging)(root)); }
    catch { reports.push({ root, complete: false, source: 'failed', cleanupEligibility: ELIGIBILITY }); }
  }
  const completed = reports.filter((report) => report.complete).length;
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
