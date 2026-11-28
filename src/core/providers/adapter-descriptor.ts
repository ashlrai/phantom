// Offline metadata only. A descriptor or observation never authorizes execution.
import { z } from 'zod';

const ADAPTER_DESCRIPTOR_SCHEMA = 'phantom.adapter-descriptor.v1' as const;
const ADAPTER_OBSERVATION_SCHEMA = 'phantom.adapter-observation.v1' as const;
const MAX_ADAPTERS = 256;
const MAX_CAPABILITIES = 32;
const MAX_OBSERVATION_MS = 24 * 60 * 60 * 1000;

const id = z.string().max(80).pipe(z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/));
const digest = z.string().length(71).pipe(z.string().regex(/^sha256:[a-f0-9]{64}$/));
const epochMs = z.number().int().min(0).max(8_640_000_000_000_000);

function boundedArray<T extends z.ZodType>(item: T, max: number) {
  // Refuse oversized lists before validating or allocating a parsed element list.
  return z.custom<unknown[]>(value => Array.isArray(value) && value.length <= max).pipe(z.array(item));
}

const capabilitySchema = z.object({
  id,
  inputSchemaDigest: digest.optional(),
  outputSchemaDigest: digest.optional(),
}).strict();

const adapterSchema = z.object({
  id,
  revision: digest,
  source: id,
  purpose: z.enum(['inference', 'agent-task', 'tool', 'skill']),
  transport: z.enum(['cli', 'mcp-stdio', 'mcp-http', 'http-api', 'sdk', 'a2a', 'artifact']),
  capabilities: boundedArray(capabilitySchema, MAX_CAPABILITIES),
}).strict();

const catalogSchema = z.object({
  schema: z.literal(ADAPTER_DESCRIPTOR_SCHEMA),
  adapters: boundedArray(adapterSchema, MAX_ADAPTERS),
}).strict();

const observationSchema = z.object({
  id,
  revision: digest,
  source: z.enum(['local-probe', 'protocol-negotiation']),
  observedAtMs: epochMs,
  expiresAtMs: epochMs,
}).strict();

const observationsSchema = z.object({
  schema: z.literal(ADAPTER_OBSERVATION_SCHEMA),
  observations: boundedArray(observationSchema, MAX_ADAPTERS),
}).strict();

export type AdapterDescriptor = z.infer<typeof adapterSchema>;
export type AdapterObservation = z.infer<typeof observationSchema>;
export type AdapterDescriptorCatalog = z.infer<typeof catalogSchema>;

export type AdapterEvidence =
  | { state: 'unknown'; reason: 'missing' | 'revision-mismatch' | 'future' }
  | { state: 'stale'; reason: 'expired' }
  | { state: 'reported'; source: AdapterObservation['source']; observedAtMs: number; expiresAtMs: number };

export interface AdapterProjection {
  adapter: AdapterDescriptor;
  evidence: AdapterEvidence;
}

function compareId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sortedUnique<T extends { id: string }>(rows: T[], error: string): T[] {
  const sorted = [...rows].sort(compareId);
  if (sorted.some((row, index) => index > 0 && row.id === sorted[index - 1]!.id)) {
    throw new Error(error);
  }
  return sorted;
}

/** Parse already-decoded JSON. Errors are fixed messages, not untrusted input. */
export function parseAdapterDescriptors(value: unknown): AdapterDescriptorCatalog {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid adapter descriptor catalog.');
  const adapters = sortedUnique(parsed.data.adapters, 'Duplicate adapter id.').map(adapter => ({
    ...adapter, capabilities: sortedUnique(adapter.capabilities, 'Duplicate capability id.'),
  }));
  return { schema: ADAPTER_DESCRIPTOR_SCHEMA, adapters };
}

function parseObservations(value: unknown): AdapterObservation[] {
  const parsed = observationsSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid adapter observations.');
  const observations = sortedUnique(parsed.data.observations, 'Duplicate adapter observation id.');
  if (observations.some(row => row.expiresAtMs <= row.observedAtMs ||
    row.expiresAtMs - row.observedAtMs > MAX_OBSERVATION_MS)) {
    throw new Error('Invalid adapter observation window.');
  }
  return observations;
}

function describeEvidence(adapter: AdapterDescriptor, row: AdapterObservation | undefined, nowMs: number): AdapterEvidence {
  if (!row) return { state: 'unknown', reason: 'missing' };
  if (row.revision !== adapter.revision) return { state: 'unknown', reason: 'revision-mismatch' };
  if (row.observedAtMs > nowMs) return { state: 'unknown', reason: 'future' };
  if (row.expiresAtMs <= nowMs) return { state: 'stale', reason: 'expired' };
  const { source, observedAtMs, expiresAtMs } = row;
  return { state: 'reported', source, observedAtMs, expiresAtMs };
}

/**
 * A deterministic evidence view, without a clock read, probe, account join or admission.
 * 'reported' means a caller-supplied record matches this exact descriptor revision
 * and time window. It is not proof of installation, authentication, quota or scope.
 */
export function projectAdapterEvidence(catalog: unknown, records: unknown, nowMs: number): AdapterProjection[] {
  if (!epochMs.safeParse(nowMs).success) throw new Error('Invalid adapter observation time.');
  const { adapters } = parseAdapterDescriptors(catalog);
  const byId = new Map(parseObservations(records).map(row => [row.id, row]));
  return adapters.map(adapter => ({ adapter, evidence: describeEvidence(adapter, byId.get(adapter.id), nowMs) }));
}
