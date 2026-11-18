/**
 * The owner's update rules: which channel each update type goes to. Rules live
 * in `<config>/comms/notify-rules.json` (`{"version":1,"rules":{"decision":"imessage"}}`);
 * absent or unusable, the built-in routes apply. `planUpdateDelivery` only
 * plans: it calls the one router (`planNotifyRoute`) and never sends, queues
 * or reads a credential. Sending stays with the owner-thread adapters.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { OWNER_THREAD_ID } from './leader-mailbox.js';
import {
  NOTIFY_CHANNELS, fixedOwnerConfigDir, planNotifyRoute,
  type NotifyAvailability, type NotifyUpdateType, type OwnerThreadSettings,
} from './owner-channel.js';
import {
  NOTIFY_CHANNEL_LABELS, NOTIFY_PLAN_SCHEMA, NOTIFY_RULES_SCHEMA, NOTIFY_RULE_TYPES,
  NOTIFY_SCHEMA_VERSION, NOTIFY_STATUS_WORDS, NOTIFY_UPDATE_TYPES,
  type NotifyChannel, type NotifyDeliveryPlan, type NotifyDeliveryStep, type NotifyRuleType,
  type NotifyRulesView, type NotifyUpdate, type NotifyUpdateKind,
} from './notify-rules-schema.js';

/** Each rule is one built-in route of the router, with its default channel. */
const RULES: Record<NotifyRuleType, { route: NotifyUpdateType; channel: NotifyChannel; label: string; note: string }> = {
  decision: { route: 'decision', channel: 'imessage', label: 'Decisions and approvals', note: 'Now. Reply YES or NO.' },
  incident: { route: 'incident', channel: 'imessage', label: 'Incidents', note: 'Now.' },
  'texts-digest': { route: 'digest', channel: 'imessage', label: 'Daily texts digest', note: 'Once a day.' },
  digest: { route: 'digest', channel: 'email', label: 'Email and LinkedIn digests', note: 'When the digest is ready.' },
  shipped: { route: 'merged', channel: 'email', label: 'Shipped work', note: 'In the next digest.' },
  fyi: { route: 'status', channel: 'desktop', label: 'FYI', note: 'Now.' },
};
/** Older names for the same update types. */
const ALIASES: Partial<Record<string, NotifyUpdateKind>> = { approval: 'decision', merged: 'shipped', status: 'fyi' };
const TEXT_SOURCES = new Set(['texts', 'text', 'imessage', 'sms']);

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => list.some(item => item === value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const rulesFile = (configDir: string): string => join(configDir, 'comms', 'notify-rules.json');

export function isNotifyRuleType(value: unknown): value is NotifyRuleType { return isOneOf(NOTIFY_RULE_TYPES, value); }
export function isNotifyChannel(value: unknown): value is NotifyChannel { return isOneOf(NOTIFY_CHANNELS, value); }

/** Never throws. A missing file is the defaults; a bad file or entry is the defaults plus a stated problem. */
export function readNotifyRules(opts: { configDir?: string } = {}): NotifyRulesView {
  const configDir = opts.configDir ?? fixedOwnerConfigDir();
  const chosen: Partial<Record<NotifyRuleType, NotifyChannel>> = {};
  let source: NotifyRulesView['source'] = 'defaults';
  let problem: string | null = null;
  if (existsSync(rulesFile(configDir))) {
    const read = readStableRegularFile(rulesFile(configDir), { anchorPath: configDir, maxFileBytes: 16 * 1024, remainingBytes: 16 * 1024 });
    let doc: unknown = null;
    try { doc = read.ok ? JSON.parse(read.text) : null; } catch { doc = null; }
    if (!record(doc) || doc.version !== NOTIFY_SCHEMA_VERSION || !record(doc.rules)) {
      problem = 'The rules file could not be used, so the defaults apply.';
    } else {
      source = 'file';
      for (const [type, channel] of Object.entries(doc.rules)) {
        if (isNotifyRuleType(type) && isNotifyChannel(channel)) chosen[type] = channel;
        else problem = `Ignored the rule "${type.slice(0, 40)}": unknown update type or channel.`;
      }
    }
  }
  return {
    schema: NOTIFY_RULES_SCHEMA, version: NOTIFY_SCHEMA_VERSION, source, problem, mirror: 'desktop',
    channels: NOTIFY_CHANNELS.map(id => ({ id, label: NOTIFY_CHANNEL_LABELS[id] })),
    rules: NOTIFY_RULE_TYPES.map(type => {
      const channel = chosen[type] ?? RULES[type].channel;
      return { type, label: RULES[type].label, channel, isDefault: channel === RULES[type].channel, note: RULES[type].note };
    }),
  };
}

/** Set one rule and return the new view. Writes the whole file atomically, owner-only. */
export function setNotifyRule(type: NotifyRuleType, channel: NotifyChannel, opts: { configDir?: string } = {}): NotifyRulesView {
  const configDir = opts.configDir ?? fixedOwnerConfigDir();
  const rules = Object.fromEntries(readNotifyRules({ configDir }).rules
    .map(row => [row.type, row.type === type ? channel : row.channel] as const)
    .filter(([key, value]) => value !== RULES[key].channel));
  const file = rulesFile(configDir);
  mkdirSync(join(configDir, 'comms'), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify({ version: NOTIFY_SCHEMA_VERSION, rules }, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return readNotifyRules({ configDir });
}

/** A named type wins (unrecognized stays unknown); otherwise the text decides, and plain news is an FYI. */
export function classifyUpdate(update: NotifyUpdate): { type: NotifyUpdateKind | 'unknown'; rule: NotifyRuleType | null } {
  let type: NotifyUpdateKind | 'unknown';
  if (update.type !== undefined) {
    const named = String(update.type).trim().toLowerCase();
    type = ALIASES[named] ?? (isOneOf(NOTIFY_UPDATE_TYPES, named) ? named : 'unknown');
  } else {
    const text = typeof update.text === 'string' ? update.text : '';
    type = /\b(incident|outage|is down|failing|broken)\b/i.test(text) ? 'incident'
      : /\b(approv\w*|decide|decision|yes or no)\b|\?\s*$/i.test(text) ? 'decision'
      : /\bdigest\b/i.test(text) ? 'digest'
      : /\b(shipped|merged|released|landed)\b/i.test(text) ? 'shipped' : 'fyi';
  }
  if (type === 'unknown') return { type, rule: null };
  const texts = type === 'digest' && typeof update.source === 'string' && TEXT_SOURCES.has(update.source.trim().toLowerCase());
  return { type, rule: texts ? 'texts-digest' : type };
}

export interface PlanUpdateOptions {
  rules: NotifyRulesView;
  /** The owner and team allowlist; anyone else is outside the team. */
  settings: Pick<OwnerThreadSettings, 'owners' | 'team'>;
  availability?: Partial<Record<NotifyChannel, NotifyAvailability>>;
}

/** Plan where one update goes. Pure: same update, rules and settings give the same plan. */
export function planUpdateDelivery(update: NotifyUpdate, opts: PlanUpdateOptions): NotifyDeliveryPlan {
  const availability = opts.availability ?? {};
  const { type, rule } = classifyUpdate(update);
  const to = record(update.to) && typeof update.to.channel === 'string' && typeof update.to.id === 'string' && update.to.id ? update.to : null;
  const insideTeam = to === null
    || Object.entries(opts.settings.owners).some(([channel, id]) => channel === to.channel && id === to.id)
    || opts.settings.team.some(member => member.channel === to.channel && member.id === to.id);
  const action = insideTeam ? 'send' : 'draft';
  const row = rule ? opts.rules.rules.find(candidate => candidate.type === rule) : undefined;
  const route = rule ? planNotifyRoute(RULES[rule].route, availability, row?.channel ?? RULES[rule].channel) : null;
  const deliveries: NotifyDeliveryStep[] = [];
  if (route?.channel && route.delivery !== 'blocked') {
    deliveries.push({ channel: route.channel, role: 'primary', action, delivery: route.delivery, availability: route.availability, threadId: OWNER_THREAD_ID });
  }
  // Everything is mirrored in the desktop app; an unknown type goes there only.
  if (!deliveries.some(step => step.channel === 'desktop') && availability.desktop !== 'unavailable') {
    deliveries.push({ channel: 'desktop', role: route ? 'mirror' : 'primary', action, delivery: 'now', availability: availability.desktop ?? 'unknown', threadId: OWNER_THREAD_ID });
  }
  const reason = [
    route ? route.reason : 'Unknown update type, so it goes to the desktop app only.',
    ...(insideTeam ? [] : ['The recipient is outside the team, so this is a draft and is never sent.']),
    ...(deliveries.length ? [] : ['No channel is available.']),
  ].join(' ');
  return {
    schema: NOTIFY_PLAN_SCHEMA, version: NOTIFY_SCHEMA_VERSION, sent: false,
    updateId: typeof update.id === 'string' && update.id ? update.id : 'unknown',
    threadId: OWNER_THREAD_ID, type, rule,
    status: update.status === undefined ? null : isOneOf(NOTIFY_STATUS_WORDS, update.status) ? update.status : 'unknown',
    text: typeof update.text === 'string' ? update.text : null,
    recipient: to ? { channel: to.channel, id: to.id } : 'owner', insideTeam, draftOnly: !insideTeam,
    replyFormat: route?.replyFormat ?? null, rulesSource: opts.rules.source, deliveries, reason,
  };
}
