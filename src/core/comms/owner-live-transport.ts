/**
 * Production transports. They send only to the configured owner and never log
 * credential values. Tests inject their own transports and do not import this.
 */
import type { OwnerChannel } from './leader-mailbox.js';
import { OWNER_SECRET_HANDLES, type OwnerChannelTransport, type OwnerThreadSettings } from './owner-channel.js';

function refused(): { status: 'refused'; reason: string } {
  return { status: 'refused', reason: 'refused' };
}

export function liveOwnerTransports(settings: OwnerThreadSettings, runsDir: string): Partial<Record<OwnerChannel, OwnerChannelTransport>> {
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
        if (settings.secretHandles.email !== OWNER_SECRET_HANDLES.email || input.ownerId !== settings.owners.email) return refused();
        const address = input.ownerId.startsWith('email:') ? input.ownerId.slice('email:'.length) : '';
        const { readEmailDropConfig } = await import('./email-drop-config.js');
        const saved = await readEmailDropConfig(runsDir);
        if (!address || saved.state !== 'ok' || saved.config?.enabled === false || saved.config?.sendReplies !== true || !saved.config.from.includes(address)) return refused();
        const { macMailTransport } = await import('./email-outbox.js');
        const result = await macMailTransport()({ to: address, subject: 'Leader', body: input.text });
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
        const { deliverSlackLeaderMessage } = await import('../agents/slack-leader.js');
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
