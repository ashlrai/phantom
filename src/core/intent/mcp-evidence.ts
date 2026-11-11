import { assertMetadata } from '../connectors/profile.js';
import { linkMergedPull, MAX_RELEASE_REF } from './evidence.js';
import { noteShippedRelease } from './release.js';
import { MAX_RQ, MAX_TITLE, normalizeRq, validRepo } from './schema.js';
import { ledgerFilePresent, readLedger, writeLedger } from './store.js';

const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const timestamp = { type: 'string', maxLength: 35, format: 'date-time' };
export const EVIDENCE_SCHEMAS = {
  intent_link: { type: 'object', properties: {
    repo: text(200), number: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    title: text(MAX_TITLE), branch: text(MAX_TITLE), url: text(2048), at: timestamp,
  }, required: ['repo', 'number', 'title'], additionalProperties: false },
  intent_ship: { type: 'object', properties: {
    release: text(MAX_RELEASE_REF), notes: text(10000), rq: { type: 'array', minItems: 1, maxItems: MAX_RQ, items: text(200) }, at: timestamp,
  }, required: ['release'], additionalProperties: false },
} as const;

type ToolName = keyof typeof EVIDENCE_SCHEMAS;
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && v.trim().length > 0;

/** Validate the complete wire contract without echoing caller input. */
export function validEvidenceArgs(name: ToolName, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const a = raw as Record<string, unknown>;
  const allowed = Object.keys(EVIDENCE_SCHEMAS[name].properties);
  if (Object.keys(a).some(key => !allowed.includes(key))) return false;
  if (a.at !== undefined && (!bounded(a.at, 35) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(a.at) || Number.isNaN(Date.parse(a.at)))) return false;
  if (name === 'intent_link') {
    return bounded(a.repo, 200) && validRepo(a.repo) && Number.isSafeInteger(a.number) && (a.number as number) > 0 &&
      bounded(a.title, MAX_TITLE) && (a.branch === undefined || bounded(a.branch, MAX_TITLE)) &&
      (a.url === undefined || bounded(a.url, 2048));
  }
  if (!bounded(a.release, MAX_RELEASE_REF) || (a.notes !== undefined && !bounded(a.notes, 10000)) ||
      (a.notes === undefined && a.rq === undefined)) return false;
  if (a.rq !== undefined) {
    if (!Array.isArray(a.rq) || a.rq.length < 1 || a.rq.length > MAX_RQ) return false;
    try { for (const key of a.rq) { if (!bounded(key, 200)) return false; normalizeRq(key); } } catch { return false; }
  }
  return true;
}

/** Record supplied evidence only; no remote verification or closure. */
export async function recordEvidence(name: ToolName, args: Record<string, unknown>): Promise<unknown> {
  try {
    assertMetadata(JSON.stringify(args));
    const ledger = await readLedger();
    if (!await ledgerFilePresent()) return { ok: false, error: 'Intent ledger unavailable.' };
    const at = (args.at as string | undefined) ?? new Date().toISOString();
    if (name === 'intent_ship') {
      const result = await noteShippedRelease({ release: args.release as string, notes: args.notes as string | undefined,
        rq: (args.rq as string[] | undefined)?.map(normalizeRq) }, { now: at });
      return { ok: true, ...result };
    }
    const matches = linkMergedPull(ledger, { repo: args.repo as string, number: args.number as number,
      title: args.title as string, branch: args.branch as string | undefined, url: args.url as string | undefined }, at);
    if (matches.length) await writeLedger(ledger);
    return { ok: true, updated: matches.length, matches: matches.map(({ id, status }) => ({ id, status })) };
  } catch {
    return { error: 'Intent evidence could not be recorded.' };
  }
}
