/** Host-enrolled identities. Registration only drafts; it cannot mint a binding. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { realHome } from '../real-home.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { scrubSecrets } from '../util/scrub.js';
import { localWriteGate } from '../agents/send-gate.js';
import { appendBusInbox } from '../fleet/bus-inbox.js';
import { appendNeedsMasonLine } from '../fleet/needs-mason-append.js';

export const callsignSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}(?![\s\S])/).refine(v => scrubSecrets(v) === v);
const label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}(?![\s\S])/).refine(v => scrubSecrets(v) === v);
const bindingSchema = z.object({
  callsign: callsignSchema, lane: label, sessionId: label,
  sessionHash: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/), expiresAt: z.number().int().nonnegative(),
  teamId: z.string().regex(/^T[A-Z0-9]{2,32}(?![\s\S])/),
  userId: z.string().regex(/^[UW][A-Z0-9]{2,32}(?![\s\S])/), botId: z.string().regex(/^B[A-Z0-9]{2,32}(?![\s\S])/),
  topic: label,
}).strict();
export type PeerBinding = z.infer<typeof bindingSchema>;
export interface PeerSession { lane: string; sessionId: string; token: string }
export function agentnetPaths() {
  const home = realHome();
  if (!home) throw new Error('peer-home-unavailable');
  return { bindings: join(home, '.ashlr', 'agentnet', 'bindings.json'),
    busRoot: join(home, '.ashlr', 'fleet'), runsDir: join(home, '.ashlr-runs') };
}
/** No symlinks, hardlinks, public files or unbounded reads; errors never include contents. */
export function readPeerJson(path: string, anchor: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) ||
      (process.getuid && stat.uid !== process.getuid())) throw new Error('peer-storage-unavailable');
  const read = readStableRegularFile(path, { anchorPath: anchor, maxFileBytes: 512 * 1024, remainingBytes: 512 * 1024 });
  if (!read.ok) throw new Error('peer-storage-unavailable');
  return JSON.parse(read.text);
}
export function readPeerBindings(path = agentnetPaths().bindings): PeerBinding[] {
  const parsed = z.object({ version: z.literal(1), peers: z.array(bindingSchema).max(128) }).strict()
    .parse(readPeerJson(path, join(path, '..'))).peers;
  for (const key of ['callsign', 'userId', 'botId', 'sessionHash'] as const) {
    if (new Set(parsed.map(p => p[key])).size !== parsed.length) throw new Error('peer-binding-conflict');
  }
  return parsed;
}
export function authenticatePeer(peers: PeerBinding[], session: PeerSession, now: number): PeerBinding {
  if (!session || typeof session.token !== 'string' || session.token.length < 32 || session.token.length > 512) throw new Error('peer-session-refused');
  const digest = createHash('sha256').update(JSON.stringify([session.lane, session.sessionId, session.token])).digest();
  const peer = peers.find(p => p.lane === session.lane && p.sessionId === session.sessionId && p.expiresAt > now &&
    timingSafeEqual(Buffer.from(p.sessionHash, 'hex'), digest));
  if (!peer) throw new Error('peer-session-refused');
  return peer;
}
export function listPeers(path?: string) {
  const bindings = path ?? agentnetPaths().bindings;
  try { lstatSync(bindings); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'not-enrolled', peers: [] };
    throw error;
  }
  return { status: 'ok', peers: readPeerBindings(bindings).map(p => ({ callsign: p.callsign, lane: p.lane, displayName: p.callsign,
    userId: p.userId, botId: p.botId, active: p.expiresAt > Date.now() })) };
}
/** What `inspectPeerBindings` reports about the bindings file every peer
 * verb authenticates against — retained counts only, never binding fields. */
export interface PeerBindingsInspection {
  /** 'missing' when the file is verifiably absent — no peer is enrolled;
   * 'unavailable' when it exists but fails the same custody, shape or
   * conflict checks `readPeerBindings` applies — the failure that makes
   * every `peers` verb refuse; 'available' when it read cleanly. */
  source: 'missing' | 'available' | 'unavailable';
  /** Binding rows retained; 0 on a verified-missing file, null when it
   * cannot be read or validated. */
  peers: number | null;
  /** Rows whose `expiresAt` is still ahead of the read's clock — sessions
   * that can authenticate now, the same split `listPeers` reports per
   * row; same null rule. */
  active: number | null;
}
/**
 * Read-only probe of the peer bindings store `readPeerBindings` validates
 * for `peers send|post|read|list|dispatch` authentication and
 * `consumePeerWork`'s consumer check — the count-only counterpart of
 * `listPeers`' enrollment read. Never throws and never writes: an absent
 * file is a verified-empty store (real zeros); a file failing custody,
 * schema or uniqueness reports `unavailable` with null counts. Binding
 * contents — callsigns, lanes, session ids, hashes, team/user/bot ids —
 * are never read out, only counted.
 */
export function inspectPeerBindings(path: string, now: number = Date.now()): PeerBindingsInspection {
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { source: 'missing', peers: 0, active: 0 };
    }
    return { source: 'unavailable', peers: null, active: null };
  }
  try {
    const rows = readPeerBindings(path);
    return { source: 'available', peers: rows.length,
      active: rows.filter(row => row.expiresAt > now).length };
  } catch {
    return { source: 'unavailable', peers: null, active: null };
  }
}
/** Draft metadata is never eligible for the Slack drain. Approval does not provision an app. */
export function proposeSlackAction(action: 'identity.register' | 'channel.create', name: string, apply = false,
  paths = agentnetPaths()) {
  callsignSchema.parse(name);
  const draft = { status: 'drafted', action, name, displayName: name, private: true,
    gate: 'comms.toml:confirmedByMason', requires: 'reviewed-slack-provisioner', dryRun: !apply };
  if (apply) {
    const blocked = localWriteGate();
    if (blocked) return blocked;
    const result = appendBusInbox({ id: `peer-draft-${action}-${name}`, from: 'agentnet', to: 'leaders', priority: 'P2',
      ttl: 7 * 86_400_000, body: { kind: 'peer.draft', ...draft } }, { root: paths.busRoot });
    if (result.status !== 'posted' && result.status !== 'duplicate') throw new Error('peer-draft-unavailable');
    if (result.status === 'posted') appendNeedsMasonLine(paths.runsDir, `Agentnet ${action} draft: ${name}; requires reviewed provisioning and comms approval.`);
  }
  return draft;
}
