import { z } from 'zod';
import { scrubSecrets } from '../util/scrub-secrets.js';

export const HANDOFF_RECORD_BYTES = 32 * 1024;
export const HANDOFF_LOG_BYTES = 4 * 1024 * 1024;
export const handoffId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/);
export const handoffModel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
export const handoffTier = z.enum(['fast', 'mid', 'work', 'frontier']);
const text = z.string().trim().min(1).max(2048);
const items = z.array(text).max(32);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const entireId = z.string().regex(/^(?:[a-f0-9]{12}|[0-7][0-9A-HJKMNP-TV-Z]{25})$/);
export const handoffDraftSchema = z.object({
  job: handoffId, attempt: handoffId,
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  lane: handoffId, model: handoffModel, minTier: handoffTier,
  needs: z.array(handoffId).max(32),
  goal: text,
  plan: z.array(z.object({ action: text, state: z.enum(['pending', 'done']) }).strict()).min(1).max(32),
  filesTouched: z.array(z.string().min(1).max(512).refine(p => !p.startsWith('/') && !p.includes('\\') &&
    !p.split('/').some(s => s === '..' || s === '.') && ![...p].some(c => c.charCodeAt(0) < 32))).max(128),
  decisions: items, evidence: items, nextAction: text,
  contextDigest: z.string().max(8192),
}).strict();
export const handoffSignalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('checkpoint') }).strict(),
  z.object({ kind: z.literal('rate-limit'), status: z.literal(429) }).strict(),
  z.object({ kind: z.literal('quota-exhausted') }).strict(),
  z.object({ kind: z.literal('budget'), remainingFraction: z.number().min(0).max(1),
    threshold: z.number().min(0).max(1) }).strict(),
  z.object({ kind: z.literal('completed') }).strict(),
]);
export const handoffSchema = handoffDraftSchema.extend({
  schema: z.literal('session-handoff.v1'), revision: z.number().int().positive(),
  at: z.string().datetime(), signal: handoffSignalSchema,
  repoState: z.object({ root: text, head: z.string().regex(/^[a-f0-9]{40,64}$/), digest,
    entireCheckpoint: entireId.nullable() }).strict(),
}).strict();
export type HandoffDraft = z.infer<typeof handoffDraftSchema>;
export type HandoffSignal = z.infer<typeof handoffSignalSchema>;
export type SessionHandoff = z.infer<typeof handoffSchema>;
/** Every signal kind the wire union accepts, derived once so list filters and tool schemas share the vocabulary. */
export const HANDOFF_SIGNAL_KINDS: readonly HandoffSignal['kind'][] =
  handoffSignalSchema.options.map(option => option.shape.kind.value);
export class SessionHandoffError extends Error {}
export const refuseHandoff = (reason: string): never => { throw new SessionHandoffError(reason); };

/** Scrub before bounding so a cut cannot turn a credential into an unrecognised prefix. */
export function scrubHandoffDraft(value: unknown): HandoffDraft {
  const scrub = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') return key === 'contextDigest' ? scrubSecrets(v).slice(0, 8192) : scrubSecrets(v);
    if (Array.isArray(v)) return v.map(item => scrub(item));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, scrub(item, k)]));
    return v;
  };
  const result = handoffDraftSchema.safeParse(scrub(value));
  if (!result.success) return refuseHandoff('Invalid handoff draft.');
  return result.data;
}

export function parseHandoff(value: unknown): SessionHandoff {
  const result = handoffSchema.safeParse(value);
  if (!result.success) return refuseHandoff('Invalid handoff record.');
  const { schema: _schema, revision: _revision, at: _at, signal: _signal, repoState, ...draft } = result.data;
  if (JSON.stringify(scrubHandoffDraft(draft)) !== JSON.stringify(draft) || scrubSecrets(repoState.root) !== repoState.root ||
      Buffer.byteLength(JSON.stringify(result.data)) > HANDOFF_RECORD_BYTES) return refuseHandoff('Unsafe or oversized handoff record.');
  return result.data;
}

export function handoffPressure(signal: HandoffSignal): boolean {
  return signal.kind === 'rate-limit' || signal.kind === 'quota-exhausted' ||
    (signal.kind === 'budget' && signal.remainingFraction <= signal.threshold);
}
