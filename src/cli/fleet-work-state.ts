/** `ashlr fleet work-state` — classify work items as RECEIVED / ASSIGNED /
 * RUNNING / BLOCKED / VERIFIED from structured evidence (the Nov12 22:29 ET
 * reporting contract). Read-only: reads one local file, no network, no writes. */
import { readFileSync } from 'node:fs';
import { classifyWorkItem, type WorkItemEvidence } from '../core/comms/work-item-state.js';

const usage = 'Usage: ashlr fleet work-state --evidence <file.json> [--json]\nPrints one line per item: ID STATE as-of=... source=... missing=...\nThe file holds one WorkItemEvidence object or an array of them. Prose such as "routed" is never evidence. Read-only.';
const STRINGS = ['receivedAt', 'owner', 'claimReceipt'] as const;
const NESTED: Record<string, string[]> = { runningEvidence: ['source', 'at'], blocker: ['dependency', 'source', 'at'], verified: ['head', 'tests', 'artifact', 'source', 'at'] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Returns an error message, or null when `v` is a well-typed WorkItemEvidence. */
function invalid(v: unknown, at: string): string | null {
  if (!isObj(v)) return `${at}: expected an object`;
  if (typeof v.id !== 'string' || v.id === '') return `${at}: id must be a non-empty string`;
  for (const k of STRINGS) if (v[k] !== undefined && typeof v[k] !== 'string') return `${at}: ${k} must be a string`;
  for (const [k, fields] of Object.entries(NESTED)) {
    const o = v[k];
    if (o === undefined) continue;
    if (!isObj(o)) return `${at}: ${k} must be an object`;
    for (const f of fields) if (o[f] !== undefined && typeof o[f] !== 'string') return `${at}: ${k}.${f} must be a string`;
  }
  const pr = isObj(v.verified) ? v.verified.pr : undefined;
  if (pr !== undefined && typeof pr !== 'number') return `${at}: verified.pr must be a number`;
  return null;
}

export async function cmdFleetWorkState(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let file: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--evidence' && file === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) file = args[++i];
    else { console.error(usage); return 2; }
  }
  if (!file) { console.error(usage); return 2; }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch (err) { console.error(`error: cannot read evidence file ${file}: ${err instanceof Error ? err.message : String(err)}`); return 2; }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const [i, item] of items.entries()) {
    const bad = invalid(item, Array.isArray(parsed) ? `item ${i}` : 'evidence');
    if (bad) { console.error(`error: invalid evidence: ${bad}`); return 2; }
  }
  const nowIso = new Date().toISOString();
  const results = (items as WorkItemEvidence[]).map(e => ({ id: e.id, ...classifyWorkItem(e, nowIso) }));
  if (json) console.log(JSON.stringify(results));
  else for (const r of results) console.log(`${r.id} ${r.state} as-of=${r.asOf} source=${r.source} missing=${r.missing.length ? r.missing.join(',') : 'none'}`);
  return 0;
}
