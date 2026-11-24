/** Flat observations over existing v2 context bodies. Routing metadata is not authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { appendBusInbox, listBusInboxAfter, BUS_INBOX_MAX_MESSAGES, type BusInboxOptions } from '../fleet/bus-inbox.js';
import { scrubSecrets } from '../util/scrub.js';
import { agentAddress, agentHandleSchema, readAgentRegistry, registerAgentIdentity, resolveAgent } from './bus-identity.js';
import { contextBodySchema, providerSchema } from './bus-v2-schema.js';
import { localWriteGate } from './send-gate.js';

export const MESH_TTL_MS = 600_000;
export const MESH_FRESH_MS = 120_000;
const epoch = z.number().int().nonnegative().safe();
const observationSchema = z.object({
  source: z.enum(['desktop', 'cli', 'imessage']),
  agent: z.string().min(1).max(128), displayName: z.string().min(1).max(128),
  provider: providerSchema.nullable(), lane: z.string().min(1).max(128),
  lastSeen: epoch.nullable(), currentTask: z.string().min(1).max(1024).nullable(),
  status: z.enum(['active', 'idle', 'offline', 'unknown']), expiresAt: epoch.nullable(),
}).strict();
export type MeshObservation = z.infer<typeof observationSchema>;
export interface MeshAgent extends Omit<MeshObservation, 'expiresAt' | 'source'> {
  address: string; source: MeshObservation['source'] | 'registry'; observedAt: number | null;
}

/** No writes, probes, network calls, role checks or claim mutations. */
export function readAgentMesh(options: BusInboxOptions = {}) {
  const now = (options.now ?? Date.now)(), fixed = { ...options, now: () => now };
  const registry = readAgentRegistry(fixed);
  if (registry.status !== 'ok') return { status: 'unavailable' as const, agents: [] as MeshAgent[] };
  const agents = new Map<string, MeshAgent>(registry.registry.identities.map(identity => {
    const runtime = [...identity.runtimes].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    return [identity.handle, { agent: identity.handle, address: agentAddress(identity.handle),
      displayName: identity.displayName, provider: runtime?.provider ?? null, lane: runtime?.cli ?? 'unknown',
      lastSeen: runtime?.lastSeenAt ?? null, currentTask: null, status: 'unknown', source: 'registry', observedAt: null }];
  }));
  let cursor = 0;
  for (let scanned = 0; scanned < BUS_INBOX_MAX_MESSAGES; scanned += 100) {
    const page = listBusInboxAfter(cursor, 100, fixed);
    if (page.status !== 'ok') return { status: page.status, agents: [] as MeshAgent[] };
    for (const receipt of page.messages) {
      if (receipt.envelope.to !== 'fleet.mesh') continue;
      const body = contextBodySchema.safeParse(receipt.envelope.body);
      if (!body.success || body.data.thread !== 'fleet.mesh') continue;
      let decoded: unknown;
      try { decoded = JSON.parse(body.data.text); } catch { continue; }
      const parsed = observationSchema.safeParse(decoded);
      if (!parsed.success) continue;
      const { expiresAt, ...row } = parsed.data, identity = resolveAgent(registry.registry, row.agent);
      if (!identity || receipt.envelope.from !== agentAddress(identity.handle)) continue;
      const fresh = receipt.receivedAt <= now && now - receipt.receivedAt < MESH_FRESH_MS;
      const expired = expiresAt !== null && expiresAt <= now;
      agents.set(identity.handle, { ...row, agent: identity.handle, address: agentAddress(identity.handle),
        displayName: scrubSecrets(row.displayName), lane: scrubSecrets(row.lane),
        currentTask: fresh && !expired && row.currentTask ? scrubSecrets(row.currentTask) : null,
        lastSeen: row.lastSeen !== null && row.lastSeen <= now ? row.lastSeen : null,
        status: !fresh ? 'unknown' : expired ? 'offline' : row.status, observedAt: receipt.receivedAt });
    }
    if (page.messages.length < 100 || page.nextCursor <= cursor) break;
    cursor = page.nextCursor;
  }
  return { schema: 'agent-mesh.v1' as const, status: 'ok' as const, asOf: now,
    agents: [...agents.values()].sort((a, b) => a.agent.localeCompare(b.agent)) };
}

/** One id per observation/minute makes repeated samples idempotent. */
export function publishMeshObservation(input: MeshObservation, options: BusInboxOptions = {}) {
  const blocked = localWriteGate();
  if (blocked) return blocked;
  const parsed = observationSchema.safeParse(input);
  if (!parsed.success) return { status: 'invalid' as const };
  const now = (options.now ?? Date.now)(), fixed = { ...options, now: () => now };
  const registry = readAgentRegistry(fixed);
  if (registry.status !== 'ok') return registry;
  const existing = resolveAgent(registry.registry, input.agent);
  const handle = existing?.handle ?? (agentHandleSchema.safeParse(input.agent).success ? input.agent
    : 'mesh-' + createHash('sha256').update(input.agent).digest('hex').slice(0, 20));
  const registered = existing ? { identity: existing } : registerAgentIdentity({ handle,
    displayName: scrubSecrets(input.displayName),
    aliases: existing || input.agent === handle ? [] : [input.agent] }, fixed);
  if (!('identity' in registered)) return registered;
  const row = { ...parsed.data, agent: handle, displayName: scrubSecrets(input.displayName),
    provider: input.provider ?? [...(existing?.runtimes ?? [])].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]?.provider ?? null,
    lane: scrubSecrets(input.lane), currentTask: input.currentTask ? scrubSecrets(input.currentTask) : null };
  const body = contextBodySchema.parse({ kind: 'context', thread: 'fleet.mesh', text: JSON.stringify(row) });
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24);
  return appendBusInbox({ id: 'mesh-' + Math.floor(now / 60_000) + '-' + digest, from: agentAddress(handle),
    to: 'fleet.mesh', priority: 'P3', ttl: MESH_TTL_MS, body }, fixed);
}
