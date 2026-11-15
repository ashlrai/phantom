/**
 * Native MCP `intent_link` / `intent_ship`: record caller-supplied merged-PR and
 * release evidence on the existing intent ledger. Supplied claims are stored as
 * evidence only: nothing here verifies them remotely, sends anything, dispatches
 * work or closes an outcome. Static imports stay pure (schema, evidence
 * constants) so `tools/list` does not load the store; handler deps are lazy.
 */
import { normalizeRq, type EvidenceToolName } from './schema.js';
export { EVIDENCE_SCHEMAS, validEvidenceArgs, type EvidenceToolName } from './schema.js';

/** Record supplied evidence only; no remote verification, send, dispatch or closure. */
export async function recordEvidence(name: EvidenceToolName, args: Record<string, unknown>): Promise<unknown> {
  try {
    const { assertMetadata } = await import('../connectors/profile.js');
    assertMetadata(JSON.stringify(args));
    const { ledgerFilePresent, readLedger, writeLedger } = await import('./store.js');
    if (!await ledgerFilePresent()) return { ok: false, error: 'Intent ledger unavailable.' };
    const ledger = await readLedger();
    const at = (args.at as string | undefined) ?? new Date().toISOString();
    if (name === 'intent_ship') {
      const { noteShippedRelease } = await import('./release.js');
      const result = await noteShippedRelease({ release: args.release as string, notes: args.notes as string | undefined,
        rq: (args.rq as string[] | undefined)?.map(normalizeRq) }, { now: at });
      return { ok: true, ...result };
    }
    const { linkMergedPull } = await import('./evidence.js');
    const matches = linkMergedPull(ledger, { repo: args.repo as string, number: args.number as number,
      title: args.title as string, branch: args.branch as string | undefined, url: args.url as string | undefined }, at);
    if (matches.length) await writeLedger(ledger);
    return { ok: true, updated: matches.length, matches: matches.map(({ id, status }) => ({ id, status })) };
  } catch {
    return { error: 'Intent evidence could not be recorded.' };
  }
}
