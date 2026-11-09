/**
 * Production transports. They send only to the configured owner and never log
 * credential values. Email and Slack re-check the fixed ~/.ashlr owner; env
 * directory overrides are ignored. Tests inject fakes and do not send.
 */
import { parseSlackThreadRef, isSlackUserId } from '../agents/slack-network.js';
import { OWNER_SECRET_HANDLES, fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings, type OwnerChannelTransport, type OwnerThreadSettings } from './owner-channel.js';
import type { OwnerChannel } from './leader-mailbox.js';

type SlackProbe = (method: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface LiveTransportDeps {
  sendMail?: (message: { to: string; subject: string; body: string }) => Promise<{ ok: boolean }>;
  slackCall?: SlackProbe;
}

function refused(): { status: 'refused'; reason: string } {
  return { status: 'refused', reason: 'refused' };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The address Mail.app may receive, or null. Reads only the fixed owner home. */
export async function resolveLiveEmailRecipient(ownerId: string): Promise<string | null> {
  const fixed = loadOwnerThreadSettings(fixedOwnerConfigDir());
  const owner = fixed.owners.email;
  if (fixed.secretHandles.email !== OWNER_SECRET_HANDLES.email || !owner || ownerId !== owner || !owner.startsWith('email:')) return null;
  const address = owner.slice('email:'.length);
  const { readEmailDropConfig } = await import('./email-drop-config.js');
  const saved = await readEmailDropConfig(fixedOwnerRunsDir());
  if (!address || saved.state !== 'ok' || saved.config?.enabled === false || saved.config?.sendReplies !== true || !saved.config.from.includes(address)) return null;
  return address;
}

/**
 * True only for a 1:1 Slack DM whose two members are the configured owner and
 * this bot. Any other conversation, including a multi-member channel, is false.
 */
export async function proveOwnerDirectMessage(call: SlackProbe, channelRef: string, ownerId: string): Promise<boolean> {
  const ref = parseSlackThreadRef(channelRef);
  if (!ref || !ref.channelId.startsWith('D') || !isSlackUserId(ownerId)) return false;
  try {
    const info = await call('conversations.info', { channel: ref.channelId });
    const channel = info.channel;
    if (!record(channel) || channel.id !== ref.channelId || channel.is_im !== true || channel.is_mpim === true ||
        channel.is_shared === true || channel.is_ext_shared === true || channel.is_pending_ext_shared === true) return false;
    const members = await call('conversations.members', { channel: ref.channelId, limit: 100 });
    const meta = members.response_metadata;
    const cursor = record(meta) ? meta.next_cursor : '';
    if (typeof cursor === 'string' && cursor.trim() !== '') return false;
    const ids = members.members;
    if (!Array.isArray(ids) || ids.length !== 2 || ids.some(id => typeof id !== 'string') || !ids.includes(ownerId)) return false;
    const other = ids.find(id => id !== ownerId);
    const auth = await call('auth.test');
    return other === auth.user_id || other === auth.bot_id;
  } catch {
    return false;
  }
}

export function liveOwnerTransports(settings: OwnerThreadSettings, _runsDir: string, deps: LiveTransportDeps = {}): Partial<Record<OwnerChannel, OwnerChannelTransport>> {
  return {
    desktop: {
      async pull() { return []; },
      async deliver(input) {
        return input.ownerId === settings.owners.desktop ? { status: 'sent', reason: 'sent' } : refused();
      },
    },
    telegram: {
      async pull() { return []; },
      async deliver(input) {
        if (settings.secretHandles.telegram !== OWNER_SECRET_HANDLES.telegram || input.ownerId !== settings.owners.telegram) return refused();
        const { loadConfig } = await import('../config.js');
        const { sendTelegramMessage } = await import('../integrations/telegram.js');
        const cfg = await loadConfig();
        const chatId = cfg.comms?.telegram?.chatId;
        if (!chatId || input.ownerId !== `telegram:${chatId}`) return refused();
        const result = await sendTelegramMessage(input.text, undefined, cfg);
        return result.ok ? { status: 'sent', reason: 'sent' } : refused();
      },
    },
    email: {
      async pull() { return []; },
      async deliver(input) {
        const address = await resolveLiveEmailRecipient(input.ownerId);
        if (!address) return refused();
        const send = deps.sendMail ?? (async message => {
          const { macMailTransport } = await import('./email-outbox.js');
          return macMailTransport()(message);
        });
        const result = await send({ to: address, subject: 'Leader', body: input.text });
        return result.ok ? { status: 'sent', reason: 'sent' } : refused();
      },
    },
    imessage: {
      async pull() { return []; },
      async deliver(input) {
        if (settings.imessageBridge !== 'loopback' || process.platform !== 'darwin' || input.ownerId !== settings.owners.imessage) return refused();
        const { loadConfig } = await import('../config.js');
        const { sendIMessageOutbox } = await import('./imessage-outbox.js');
        const cfg = await loadConfig();
        const handle = cfg.comms?.imessageHandle;
        if (!handle || input.ownerId !== handle) return refused();
        const result = await sendIMessageOutbox(input.text, cfg, handle);
        return result.ok ? { status: 'sent', reason: 'sent' } : refused();
      },
    },
    slack: {
      async pull() { return []; },
      async deliver(input) {
        if (settings.secretHandles.slack !== OWNER_SECRET_HANDLES.slack || input.ownerId !== settings.owners.slack || !input.channelRef) return refused();
        const { readSlackDeliveryPolicy, configuredSlackCall, deliverSlackLeaderMessage } = await import('../agents/slack-leader.js');
        const policy = readSlackDeliveryPolicy();
        const call = deps.slackCall ?? (policy ? configuredSlackCall(policy.config) : undefined);
        if (!call || !(await proveOwnerDirectMessage(call, input.channelRef, input.ownerId))) return refused();
        const { CHANNEL_BUS_TTL_MS } = await import('../fleet/channel-bus-publish.js');
        const result = await deliverSlackLeaderMessage({ channel: 'slack', id: input.ownerId }, {
          id: `own-${input.idempotencyKey}`.slice(0, 120),
          from: 'leader', to: 'mason', priority: 'P0', ttl: CHANNEL_BUS_TTL_MS,
          body: { kind: 'leader-reply', text: input.text },
          channel: 'slack', channel_ref: input.channelRef,
          sender: { agent_id: 'leader', vendor: 'phantom', human: false, team: true },
          external: false, origin_bridge: 'leader-network',
        });
        return result.status === 'sent' ? { status: 'sent', reason: 'sent' } : refused();
      },
    },
  };
}
