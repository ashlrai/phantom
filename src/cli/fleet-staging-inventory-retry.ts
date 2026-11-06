import { isAbsolute, normalize } from 'node:path';
import { ELIGIBILITY, inventoryStaging } from '../core/fleet/staging-inventory.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = 'usage: ashlr fleet staging-inventory-retry --stdin --json (batch report, max 1 MiB)';
// Bound input before decoding or parsing, including multibyte UTF-8.
const MAX_BYTES = 1024 * 1024;
type Input = AsyncIterable<Uint8Array | string> & { isTTY?: boolean };
type Report = Awaited<ReturnType<typeof inventoryStaging>>;
type Item = Record<string, unknown> & { root: string; complete: boolean };
type Deps = {
  input?: Input;
  scanner?: (root: string) => Promise<Report>;
  output?: { log: (line: string) => void; error: (line: string) => void };
};

async function readReport(input: Input): Promise<Item[] | null> {
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
  const batch = value as Record<string, unknown>;
  if (batch.schema !== 'fleet.staging-inventory-batch.v1' || !Array.isArray(batch.reports)
    || batch.reports.length < 1 || batch.reports.length > 8 || batch.requested !== batch.reports.length
    || batch.interrupted === true) return null;
  const roots = new Set<string>();
  const reports: Item[] = [];
  for (const value of batch.reports) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (typeof item.root !== 'string' || item.root.includes('\0') || !isAbsolute(item.root)
      || normalize(item.root) !== item.root || roots.has(item.root) || typeof item.complete !== 'boolean') return null;
    // The batch emits either a scanner report or a minimal failure sentinel.
    if (item.source === 'failed') {
      if (item.complete !== false) return null;
    } else if (item.schema !== 'fleet.staging-inventory.v1'
      || typeof item.generatedAt !== 'string' || !Number.isFinite(Date.parse(item.generatedAt))
      || (item.complete ? !['ok', 'missing'].includes(String(item.source)) : item.source !== 'degraded')) return null;
    roots.add(item.root);
    reports.push(item as Item);
  }
  if (batch.completed !== reports.filter(item => item.complete).length) return null;
  return reports;
}

export async function cmdFleetStagingInventoryRetry(args: string[], deps: Deps = {}): Promise<number> {
  const output = deps.output ?? console;
  if (args.length !== 2 || !args.includes('--stdin') || !args.includes('--json')) {
    output.error(USAGE); return 2;
  }
  let reports: Item[] | null;
  try { reports = await readReport(deps.input ?? process.stdin); } catch { reports = null; }
  if (!reports) { output.error(USAGE); return 2; }
  for (let i = 0; i < reports.length; i++) {
    const previous = reports[i]!;
    if (previous.complete) continue;
    try {
      const fresh = await (deps.scanner ?? inventoryStaging)(previous.root);
      reports[i] = fresh as unknown as Item;
    } catch {
      reports[i] = { root: previous.root, complete: false, source: 'failed', cleanupEligibility: ELIGIBILITY };
    }
  }
  const completed = reports.filter(item => item.complete).length;
  output.log(JSON.stringify(sanitizePublicJson({ schema: 'fleet.staging-inventory-batch.v1', requested: reports.length, completed, reports })));
  return completed === reports.length ? 0 : 1;
}
