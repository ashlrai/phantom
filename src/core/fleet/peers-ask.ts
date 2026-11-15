/** Exact short peer-budget asks; longer requests stay with the Leader. */
import { peerPairSelectorSchema, type PeerPairSelector } from '../agentnet/peer-ledger.js';

export type PeersAsk = { kind: 'aggregate' } | { kind: 'pair'; pair: PeerPairSelector };

const AGGREGATE = /^(?:peers|peer budget|peer ledger)$/;
const PAIR = /^peer (?:budget|ledger) from ([a-z][a-z0-9-]{0,31}) to ([a-z][a-z0-9-]{0,31})$/;

/** The exact ask, or undefined for prose that belongs to the Leader. A pair ask
 * names both callsigns explicitly; nothing is inferred from the sender, the
 * thread or fuzzy prose, and both names must pass the stored-row validators. */
export function parsePeersAsk(text: string): PeersAsk | undefined {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length === 0) return undefined;
  const ask = trimmed.toLowerCase().replace(/’/g, "'").replace(/[?.!]+$/, '').trim();
  // The aggregate keywords keep the original raw-length gate; the pair pattern
  // below is self-bounding (two callsign tokens), so longer pair asks still parse.
  if (trimmed.length <= 40 && AGGREGATE.test(ask)) return { kind: 'aggregate' };
  const pair = PAIR.exec(ask);
  if (pair === null) return undefined;
  const parsed = peerPairSelectorSchema.safeParse({ fromAgent: pair[1], target: pair[2] });
  return parsed.success ? { kind: 'pair', pair: parsed.data } : undefined;
}

export function isPeersAsk(text: string): boolean {
  return parsePeersAsk(text) !== undefined;
}
