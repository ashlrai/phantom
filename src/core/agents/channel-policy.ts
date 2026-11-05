/** Channel contracts and fail-closed policy. These functions never deliver messages. */
import { parse } from 'smol-toml';
import { BUS_CHANNELS, type BusEnvelope } from '../fleet/bus-envelope.js';

export const CHANNEL_IDS = BUS_CHANNELS;
export type ChannelId = typeof CHANNEL_IDS[number];
export type BusMessage = BusEnvelope;
export interface DeliverResult {
  status: 'sent' | 'drafted' | 'refused';
  reason: string;
}
export interface ChannelAdapter {
  readonly id: ChannelId;
  ingest(): AsyncIterable<BusMessage>;
  deliver(msg: BusMessage): Promise<DeliverResult>;
}
export interface TeamIdentity { channel: ChannelId; id: string }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function channel(value: unknown): value is ChannelId {
  return typeof value === 'string' && CHANNEL_IDS.some(id => id === value);
}

/** Invalid configuration is an empty allowlist. Identity matching is exact and channel-scoped. */
export function parseTeamIdentities(source: string): TeamIdentity[] {
  try {
    const doc = parse(source, { unsafeKeyBehaviour: 'throw' });
    if (!record(doc.team) || !Array.isArray(doc.team.identities)) return [];
    const result: TeamIdentity[] = [];
    for (const value of doc.team.identities) {
      if (!record(value) || !channel(value.channel) || typeof value.id !== 'string' ||
          value.id.length === 0 || value.id.length > 256 || Array.from(value.id).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
          Object.keys(value).some(key => key !== 'channel' && key !== 'id')) return [];
      result.push({ channel: value.channel, id: value.id });
    }
    return result;
  } catch { return []; }
}

/** Absent, malformed or non-boolean approval always means no approval. */
export function parseCommsConfirmation(source: string): boolean {
  try { return parse(source, { unsafeKeyBehaviour: 'throw' }).confirmedByMason === true; }
  catch { return false; }
}

/** Recipients must come from the channel's authenticated participant list, not envelope claims. */
export function checkSendPolicy(input: {
  channel: ChannelId;
  recipients: readonly string[];
  teamIdentities: readonly TeamIdentity[];
  external: boolean;
  confirmedByMason: boolean;
}): DeliverResult {
  if (input.external !== false || !channel(input.channel) || !input.recipients.length ||
      input.recipients.some(id => typeof id !== 'string' || !id ||
        !input.teamIdentities.some(team => team.channel === input.channel && team.id === id))) {
    return { status: 'refused', reason: 'Recipient is not an explicitly allowlisted team identity.' };
  }
  if (input.confirmedByMason !== true) {
    return { status: 'drafted', reason: 'Communication approval is not confirmed.' };
  }
  return { status: 'sent', reason: 'Team recipients and communication approval are confirmed.' };
}

/** Only a different bridge may ingest a post bearing an origin bridge. */
export function shouldIngestFromBridge(message: { origin_bridge?: string }, bridgeId: string): boolean {
  return Boolean(bridgeId) && message.origin_bridge !== bridgeId;
}
