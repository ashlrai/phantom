/**
 * phantom.channels.v1 — the wire shape of `phm channels --json` and
 * GET /api/channels. Browser-safe (types and constants only) so the desktop
 * Channels pane validates the same schema the CLI prints. Built by
 * channels-overview.ts; additive changes only, bump the version otherwise.
 */
import type { ReceiverChannel } from './channel-envelope.js';

export const CHANNELS_PATH = '/api/channels';
export const CHANNELS_OVERVIEW_SCHEMA = 'phantom.channels.v1';
export const CHANNELS_OVERVIEW_VERSION = 1;

export type ChannelOverviewState = 'connected' | 'not-set-up' | 'failing' | 'unknown';
/** A measured value, or 'unknown' when its source could not be read. */
export type Unknowable<T> = T | 'unknown';

export interface ChannelOverviewRow {
  channel: ReceiverChannel;
  /** Plain display name. */
  label: string;
  state: ChannelOverviewState;
  /** What is wrong (failing) or why the state cannot be told (unknown); null otherwise. */
  reason: string | null;
  /** ISO time of the newest inbound message; null when none was ever seen. */
  lastInboundAt: Unknowable<string | null>;
  /** ISO time of the newest outbound reply; null when none was ever sent. */
  lastOutboundAt: Unknowable<string | null>;
  /** Inbound messages received in the 24 h before `at`. */
  messages24h: Unknowable<number>;
  /** Senders the channel has verified; null for local channels with no sender check. */
  verifiedSenders: Unknowable<number> | null;
  /** The channel's address, masked (last 4 characters at most); null when none is configured. */
  address: string | null;
  /** The one plain next step; null when connected. */
  next: string | null;
}

export interface ChannelsOverview {
  schema: typeof CHANNELS_OVERVIEW_SCHEMA;
  version: typeof CHANNELS_OVERVIEW_VERSION;
  at: string;
  counts: Record<ChannelOverviewState, number>;
  /** Failing first, then unknown, not set up, connected; registry order within a state. */
  channels: ChannelOverviewRow[];
}
