/** Repository responsibility is advisory. Execution still requires a worker lease. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { participantSchema, parseClaimKey, workPostBodySchema } from '../agents/bus-v2-schema.js';
import { acquireCoordination, coordinationRoot, listCoordination, settleCoordination } from '../agents/claim-store.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { scrubSecrets } from '../util/scrub-secrets.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxReceipt } from './bus-inbox.js';

const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).refine(value => scrubSecrets(value) === value);
const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).transform(value => value.toLowerCase());
export const repoOwnersSchema = z.object({
  version: z.literal(1),
  owners: z.array(z.object({ repo, participant: participantSchema }).strict()).max(256),
}).strict().superRefine((value, ctx) => {
  for (const key of ['repo', 'participantId'] as const) {
    const ids = value.owners.map(row => key === 'repo' ? row.repo : row.participant.participantId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: `duplicate ${key}` });
  }
  if (scrubSecrets(JSON.stringify(value)) !== JSON.stringify(value)) ctx.addIssue({ code: 'custom', message: 'unsafe registry' });
});
export type RepoOwners = z.infer<typeof repoOwnersSchema>;
export const repoPrSnapshotSchema = z.object({
  version: z.literal(1), complete: z.boolean(), observedAt: z.number().int().nonnegative().safe(),
  prs: z.array(z.object({ repo, number: z.number().int().min(1).max(999_999_999),
    owner: label.nullable().optional() }).strict()).max(20_000),
  // A complete capture includes native dispatcher leases outside the bus table.
  leases: z.array(z.object({ key: z.string().refine(value => parseClaimKey(value) !== undefined),
    owner: label, leaseUntil: z.number().int().nonnegative().safe() }).strict()).max(20_000),
}).strict();
export interface OrphanItem { key: string; repo: string; jobId: string; owner?: string | null }
export interface OwnerLease { key: string; owner: string; leaseUntil: number }
export interface SweepRow extends OrphanItem {
  assignedTo: string;
  disposition: 'owned' | 'leased' | 'proposed' | 'assigned' | 'failed';
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 24);

/** Lane, tier and prompt path are deliberately not treated as ownership. */
export function readyOwnerItems(ready: string): OrphanItem[] {
  const items: OrphanItem[] = [];
  for (const line of ready.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields[0]?.startsWith('PARKED-') || fields[2]?.startsWith('PARKED-')) continue;
    const [jobId, repository, , tier] = fields;
    if (fields.length < 5 || !jobId || !label.safeParse(jobId).success || !repository ||
        !['frontier', 'work', 'mid', 'fast'].includes(tier ?? '')) throw new Error('invalid-ready-row');
    const parsed = repo.safeParse(repository.includes('/') ? repository : `ashlrai/${repository}`);
    if (!parsed.success) throw new Error('invalid-ready-repo');
    items.push({ key: `queue:${jobId}`, repo: parsed.data, jobId });
  }
  return items;
}

export function planRepoOrphans(registry: RepoOwners, items: readonly OrphanItem[], leases: readonly OwnerLease[], now: number,
  assigned: ReadonlyMap<string, string> = new Map()): { registry: RepoOwners; rows: SweepRow[] } {
  const owners = repoOwnersSchema.parse(registry).owners;
  const unique = new Map<string, OrphanItem>();
  for (const item of items) {
    const previous = unique.get(item.key);
    if (previous && (previous.repo !== item.repo || previous.owner !== item.owner)) throw new Error('conflicting-item');
    unique.set(item.key, item);
  }
  for (const repository of [...new Set(items.map(item => item.repo))].sort()) {
    if (owners.some(row => row.repo === repository)) continue;
    const participantId = `repo-owner.${digest(repository)}`;
    owners.push({ repo: repository, participant: { participantId, provider: 'codex-personal',
      displayName: `Owner of ${repository}`.slice(0, 128), capabilities: ['repo-owner', 'orphan-triage'],
      wake: { kind: 'poll', target: participantId }, status: 'idle' } });
  }
  const rows = [...unique.values()].sort((a, b) => a.key.localeCompare(b.key)).map(item => {
    const holder = leases.find(lease => {
      if (lease.leaseUntil <= now) return false;
      const parsed = parseClaimKey(lease.key);
      return lease.key === item.key || (parsed?.kind === 'pr' && `pr:${parsed.repo}#${parsed.number}` === item.key) ||
        (parsed?.kind === 'repo' && parsed.repo === item.repo);
    });
    const owner = item.owner || assigned.get(item.key);
    const assignedTo = holder?.owner ?? owner ?? owners.find(row => row.repo === item.repo)!.participant.participantId;
    return { ...item, assignedTo: label.safeParse(assignedTo).success ? assignedTo : 'unknown-owner',
      disposition: holder ? 'leased' as const : owner ? 'owned' as const : 'proposed' as const };
  });
  return { registry: repoOwnersSchema.parse({ version: 1, owners }), rows };
}

function receipts(root: string, now: number): BusInboxReceipt[] {
  const rows: BusInboxReceipt[] = [];
  let cursor = 0;
  for (let pageIndex = 0; pageIndex < 12; pageIndex++) {
    const page = listBusInboxAfter(cursor, 100, { root, now: () => now });
    if (page.status !== 'ok') throw new Error('bus-unavailable');
    rows.push(...page.messages);
    if (page.nextCursor === cursor || page.messages.length < 100) return rows;
    if (page.nextCursor < cursor) break;
    cursor = page.nextCursor;
  }
  throw new Error('bus-churn');
}

function busOwners(root: string, now: number): Map<string, string> {
  const assigned = new Map<string, string>();
  for (const receipt of receipts(root, now)) {
    const post = workPostBodySchema.safeParse(receipt.envelope.body);
    if (post.success) for (const key of post.data.claimKeys) {
      const previous = assigned.get(key);
      if (previous && previous !== receipt.envelope.from) throw new Error('conflicting-bus-owners');
      assigned.set(key, receipt.envelope.from);
    }
  }
  return assigned;
}

/** Stable bounded data only. Error messages never include file contents. */
export function readOwnerInput(file: string): string {
  const result = readStableRegularFile(file, { anchorPath: dirname(file),
    maxFileBytes: 8 * 1024 * 1024, remainingBytes: 8 * 1024 * 1024 });
  if (!result.ok) throw new Error('input-unavailable');
  return result.text;
}

function existingRegistry(file: string): string | null {
  try { lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('registry-unavailable'); }
  return readOwnerInput(file);
}

export function sweepRepoOrphans(input: {
  registry: unknown; prs: unknown; ready: string; root?: string; apply?: boolean; registerOnly?: boolean; now?: number;
}) {
  const clock = input.now === undefined ? Date.now : () => input.now!;
  const now = clock(), root = coordinationRoot(input.root);
  const snapshot = repoPrSnapshotSchema.parse(input.prs);
  if (snapshot.observedAt > now || (input.apply && !input.registerOnly && (!snapshot.complete || now - snapshot.observedAt > 900_000))) {
    throw new Error('incomplete-or-stale-pr-snapshot');
  }
  let registry = repoOwnersSchema.parse(input.registry);
  const directory = join(root, 'repo-owners'), file = join(directory, 'registry.json');
  const registrySnapshot = existingRegistry(file);
  if (registrySnapshot !== null) {
    const persisted = repoOwnersSchema.parse(JSON.parse(registrySnapshot));
    const merged = new Map(persisted.owners.map(row => [row.repo, row]));
    for (const row of registry.owners) {
      const existing = merged.get(row.repo);
      if (existing && JSON.stringify(existing) !== JSON.stringify(row)) throw new Error('owner-registry-conflict');
      merged.set(row.repo, row);
    }
    registry = repoOwnersSchema.parse({ version: 1, owners: [...merged.values()] });
  }
  const items: OrphanItem[] = input.registerOnly ? [] : [...snapshot.prs.map(pr => ({ ...pr, key: `pr:${pr.repo}#${pr.number}`,
    jobId: `repo-pr-${digest(`${pr.repo}#${pr.number}`)}` })), ...readyOwnerItems(input.ready)];
  const live = () => {
    const coordination = listCoordination(root, clock());
    if (coordination.source === 'unavailable') throw new Error('leases-unavailable');
    const leases: OwnerLease[] = [...snapshot.leases, ...coordination.claims.filter(row => row.live)];
    for (const claim of coordination.claims.filter(row => row.live && row.repo && !row.path)) {
      leases.push({ key: `repo:${claim.repo!.toLowerCase()}`, owner: claim.owner, leaseUntil: claim.leaseUntil });
    }
    return leases;
  };
  const assigned = busOwners(root, now);
  const plan = planRepoOrphans(registry, items, live(), now, assigned);
  const candidates = plan.rows.filter(row => row.disposition === 'proposed').length;
  const report = { schema: 'fleet.repo-owners.v1', dryRun: !input.apply, complete: snapshot.complete,
    mode: input.registerOnly ? 'register' : 'sweep',
    status: 'ok' as 'ok' | 'partial',
    observedAt: snapshot.observedAt, asOf: now, executionAuthorized: false, registry: plan.registry,
    registrations: [] as Array<{ repo: string; status: string }>, rows: plan.rows,
    candidates, orphansFound: snapshot.complete ? candidates : null, assigned: 0 };
  if (!input.apply) return report;
  if (existsSync(join(root, '..', 'KILL')) || existsSync(join(root, 'KILL'))) throw new Error('kill-switch');
  const key = 'queue:RQ-REPO-OWNERS-1:sweep';
  const lease = acquireCoordination({ root, origin: 'resource', key, sourceId: randomUUID(),
    owner: 'repo-owner-sweep', leaseMs: 3_600_000, leaseUntil: now + 3_600_000, now });
  if (lease.status !== 'acquired' || !lease.token) throw new Error('sweep-lease-unavailable');
  try {
    if (existingRegistry(file) !== registrySnapshot) throw new Error('registry-changed');
    ensurePrivateDirectory(directory);
    const post = (from: string, body: object, id: string) => {
      if (clock() >= lease.leaseUntil!) throw new Error('sweep-lease-expired');
      if (existsSync(join(root, '..', 'KILL')) || existsSync(join(root, 'KILL'))) throw new Error('kill-switch');
      return appendBusInbox({ id, from, to: 'repo-owners', priority: 'P2', ttl: 86_400_000, body }, { root, now: clock });
    };
    const generation = Math.floor(now / 86_400_000);
    for (const row of plan.registry.owners) {
      const body = { kind: 'context', thread: `repo-owner:${row.repo}`,
        text: JSON.stringify({ schema: 'fleet.repo-owner.v1', repo: row.repo, participant: row.participant, executionAuthorized: false }) };
      const result = post(row.participant.participantId, body, `repo-owner-${digest(JSON.stringify(row))}-${generation}`);
      report.registrations.push({ repo: row.repo, status: result.status });
      if (!['posted', 'duplicate'].includes(result.status)) { report.status = 'partial'; return report; }
    }
    writePrivateFileAtomically(join(directory, '.pending'), file, JSON.stringify(plan.registry), { anchorPath: root, label: 'Repository owners' });
    for (const row of report.rows) {
      if (row.disposition !== 'proposed') continue;
      const fresh = planRepoOrphans(plan.registry, [row], live(), now, assigned).rows[0]!;
      if (fresh.disposition !== 'proposed') { Object.assign(row, fresh); continue; }
      const at = clock();
      const reservation = acquireCoordination({ root, origin: 'resource', key: row.key, owner: row.assignedTo,
        sourceId: randomUUID(), leaseMs: 60_000, leaseUntil: at + 60_000, now: at });
      if (reservation.status === 'conflict') {
        row.disposition = 'leased'; row.assignedTo = scrubSecrets(reservation.holder.owner); continue;
      }
      if (reservation.status !== 'acquired' || !reservation.token) { report.status = 'partial'; break; }
      const participant = plan.registry.owners.find(owner => owner.repo === row.repo)!.participant;
      const body = { kind: 'work.post', jobId: row.jobId, title: `Triage ${row.key}`, repo: row.repo,
        claimKeys: [row.key], provider: participant.provider };
      try {
        const latestOwner = busOwners(root, clock()).get(row.key);
        if (latestOwner) { row.disposition = 'owned'; row.assignedTo = scrubSecrets(latestOwner); continue; }
        const result = post(row.assignedTo, body, `repo-orphan-${digest(`${row.key}:${row.assignedTo}`)}-${generation}`);
        row.disposition = ['posted', 'duplicate'].includes(result.status) ? 'assigned' : 'failed';
      } finally {
        const settled = settleCoordination({ root, key: row.key, token: reservation.token, outcome: 'released', now: clock() });
        if (settled.status !== 'released') report.status = 'partial';
      }
      if (row.disposition === 'assigned') report.assigned++;
      else { report.status = 'partial'; break; }
    }
    return report;
  } catch {
    report.status = 'partial';
    return report;
  } finally {
    const settled = settleCoordination({ root, key, token: lease.token, outcome: 'completed', now: clock() });
    if (settled.status !== 'completed') report.status = 'partial';
  }
}
