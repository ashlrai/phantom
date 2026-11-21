/** Plain-text Slack reply for Dot's live-evidence ask, rendered from the
 * sanitized DotEvidencePacket. Pure: no reads, grants nothing. */
import type { DotEvidencePacket } from './dot-evidence-packet.js';

const MAX_REPLY_CHARS = 1500;
const MAX_CLAIM_LINES = 5;

/** Defense in depth: the packet is already sanitized, but a stray absolute path
 * or control character must never reach Slack. */
const clean = (value: unknown): string =>
  String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/(^|\s)\/[^\s]*/g, '$1[path]').trim();

export function formatDotEvidenceReply(packet: DotEvidencePacket): string {
  const head = [`Phantom evidence as of ${clean(packet.asOf)} (read-only, grants nothing)`];
  const r = packet.runtime;
  head.push('state' in r
    ? 'Runtime: UNAVAILABLE'
    : `Runtime: ${clean(r.host)} installed ${clean(r.installedVersion)} source ${clean(r.sourceVersion)}${r.versionDrift ? ' drift' : ''} fleet-state ${clean(r.fleetState.ageSeconds)}s${r.fleetState.stale === true ? ' STALE' : ''}`);

  const c = packet.claims;
  const claimLines = 'state' in c ? [] : c.claims.slice(0, MAX_CLAIM_LINES)
    .map(x => `- ${clean(x.id)} ${clean(x.repo)} ${clean(x.agent)} ${clean(x.state)} until ${clean(x.expiresAt)}`);
  head.push('state' in c ? 'Claims: UNAVAILABLE' : `Claims: ${c.claims.length} live`);

  const tail = [
    `Bridge owner: ${clean(packet.bridge.owner) || 'unknown'}`,
    `Transport: ${clean(packet.bridge.transport.phantomToDot)}`,
    `Missing: ${packet.missing.length === 0 ? 'none' : packet.missing.map(clean).join(', ')}`,
  ];
  const assemble = (): string => [...head, ...claimLines, ...tail].join('\n');
  // Claim lines go first; Runtime, Bridge owner and Missing are never dropped.
  while (claimLines.length > 0 && assemble().length > MAX_REPLY_CHARS) claimLines.pop();
  if (assemble().length > MAX_REPLY_CHARS) tail[1] = `${tail[1].slice(0, 120)}…`;
  return assemble();
}
