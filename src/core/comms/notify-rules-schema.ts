/**
 * phantom.notify.rules.v1 and phantom.notify.plan.v1: the wire shapes of
 * `phm notify rules --json`, GET/POST /api/notify/rules and
 * `phm notify route <update.json> --json`. Browser-safe (types and constants
 * only) so the Channels pane reads the same schema the CLI prints. Additive
 * changes only; bump the version otherwise.
 */
import type { NotifyChannel } from './owner-channel.js';
import type { WorkState } from './work-state-contract.js';

export type { NotifyChannel };

export const NOTIFY_RULES_PATH = '/api/notify/rules';
export const NOTIFY_RULES_SCHEMA = 'phantom.notify.rules.v1';
export const NOTIFY_PLAN_SCHEMA = 'phantom.notify.plan.v1';
export const NOTIFY_SCHEMA_VERSION = 1;

export const NOTIFY_CHANNEL_LABELS: Record<NotifyChannel, string> = { imessage: 'iMessage', email: 'Email', desktop: 'Desktop app' };

/** What an update is. Anything else is 'unknown' and goes to the app only. */
export const NOTIFY_UPDATE_TYPES = ['decision', 'shipped', 'incident', 'digest', 'fyi'] as const;
export type NotifyUpdateKind = typeof NOTIFY_UPDATE_TYPES[number];
/** One editable rule per update type, plus the daily texts digest (a digest whose source is texts). */
export const NOTIFY_RULE_TYPES = ['decision', 'incident', 'texts-digest', 'digest', 'shipped', 'fyi'] as const;
export type NotifyRuleType = typeof NOTIFY_RULE_TYPES[number];

/** Status words pass through routing exactly as written. */
export const NOTIFY_STATUS_WORDS = ['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED'] as const satisfies readonly WorkState[];

export interface NotifyRuleRow {
  type: NotifyRuleType;
  /** Plain display name. */
  label: string;
  channel: NotifyChannel;
  /** False once the rules file overrides the built-in channel. */
  isDefault: boolean;
  /** Plain words for when and how it arrives. */
  note: string;
}

export interface NotifyRulesView {
  schema: typeof NOTIFY_RULES_SCHEMA;
  version: typeof NOTIFY_SCHEMA_VERSION;
  /** 'defaults' when no rules file exists or it could not be used. */
  source: 'file' | 'defaults';
  /** Why the rules file was ignored in part or whole; null when it was read cleanly or is absent. */
  problem: string | null;
  /** Every update is also shown here. */
  mirror: 'desktop';
  channels: { id: NotifyChannel; label: string }[];
  rules: NotifyRuleRow[];
}

/** The update handed to `phm notify route`. Every field is optional. */
export interface NotifyUpdate {
  id?: string;
  type?: string;
  /** For digests: texts, email or linkedin. */
  source?: string;
  text?: string;
  status?: string;
  /** Omit for the owner. Anyone outside the team gets a draft, never a send. */
  to?: { channel: string; id: string };
}

export interface NotifyDeliveryStep {
  channel: NotifyChannel;
  role: 'primary' | 'mirror';
  /** 'draft' is written for review and never sent. */
  action: 'send' | 'draft';
  delivery: 'now' | 'next-digest';
  availability: 'available' | 'unavailable' | 'unknown';
  threadId: string;
}

export interface NotifyDeliveryPlan {
  schema: typeof NOTIFY_PLAN_SCHEMA;
  version: typeof NOTIFY_SCHEMA_VERSION;
  /** Routing never sends; the channel adapters do. */
  sent: false;
  updateId: string;
  /** One thread for every channel, so a reply anywhere lands in the same place. */
  threadId: string;
  type: NotifyUpdateKind | 'unknown';
  rule: NotifyRuleType | null;
  status: typeof NOTIFY_STATUS_WORDS[number] | 'unknown' | null;
  text: string | null;
  recipient: 'owner' | { channel: string; id: string };
  insideTeam: boolean;
  draftOnly: boolean;
  replyFormat: 'YES or NO' | null;
  rulesSource: NotifyRulesView['source'];
  deliveries: NotifyDeliveryStep[];
  reason: string;
}
