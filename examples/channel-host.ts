import {
  createChannelReceiver,
  type ChannelAck,
  type ChannelReceiveResult,
  type ChannelReceiverOptions,
} from '../src/core/fleet/channel-envelope.js';

export type SampleChannel = 'desktop' | 'telegram' | 'email';

/** Evidence comes from the host's authenticated transport, not a claimed sender in the body. */
export interface InboundEvent {
  evidence: unknown;
  body: string;
}

export interface ChannelPort {
  /** Verify the transport evidence and map the account to the canonical Mason ID. */
  verifyIdentity: (evidence: unknown) => Promise<string | null>;
  /** Use the verified transport context to send back on the originating channel. */
  acknowledge: (ack: ChannelAck, evidence: unknown) => Promise<void>;
}

export interface ChannelHostOptions {
  ports: Record<SampleChannel, ChannelPort>;
  allowedSenderIds: ReadonlySet<string>;
  // Required so the example never silently writes to the host filesystem.
  write: NonNullable<ChannelReceiverOptions['write']>;
  now?: ChannelReceiverOptions['now'];
}

export type HostResult =
  | { ok: false; reason: 'unverified' | 'authentication-failed' }
  | { ok: false; reason: Extract<ChannelReceiveResult, { ok: false }>['reason'] }
  | { ok: true; receipt: Extract<ChannelReceiveResult, { ok: true }>; acknowledgement: 'sent' | 'failed' };

/** Create once per host; all three handlers share the same receiver and dedupe window. */
export function createChannelHost(options: ChannelHostOptions) {
  const receive = createChannelReceiver({
    allowedSenderIds: options.allowedSenderIds,
    write: options.write,
    now: options.now,
  });

  function adapter(channel: SampleChannel) {
    const port = options.ports[channel];
    return async (event: InboundEvent): Promise<HostResult> => {
      // Snapshot the content before awaiting authentication. Do not spread untrusted fields.
      const { body, evidence } = event;
      let verifiedSenderId: string | null;
      try {
        verifiedSenderId = await port.verifyIdentity(evidence);
      } catch {
        return { ok: false, reason: 'authentication-failed' };
      }
      if (!verifiedSenderId) return { ok: false, reason: 'unverified' };
      const result = await receive({ channel, verifiedSenderId, body });
      if (!result.ok) return result;
      try {
        await port.acknowledge({ ...result.ack }, evidence);
        return { ok: true, receipt: result, acknowledgement: 'sent' };
      } catch {
        return { ok: true, receipt: result, acknowledgement: 'failed' };
      }
    };
  }

  return { desktop: adapter('desktop'), telegram: adapter('telegram'), email: adapter('email') };
}

/** A callable in-memory demonstration. Importing this module performs no work. */
export async function runInMemoryDemo() {
  const entries: Parameters<NonNullable<ChannelReceiverOptions['write']>>[0][] = [];
  const acknowledgements: ChannelAck[] = [];
  const port = (): ChannelPort => ({
    verifyIdentity: async (evidence) => evidence === 'fake-verified-session' ? 'mason-example' : null,
    acknowledge: async (ack) => { acknowledgements.push(ack); },
  });
  const host = createChannelHost({
    ports: { desktop: port(), telegram: port(), email: port() },
    allowedSenderIds: new Set(['mason-example']),
    write: async (entry) => { entries.push(entry); return { ok: true, at: entry.receivedAt, bytes: 1 }; },
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
  const desktop = await host.desktop({ evidence: 'fake-verified-session', body: ' Hello\r\nworld ' });
  const telegram = await host.telegram({ evidence: 'fake-verified-session', body: 'Hello\nworld' });
  return { desktop, telegram, entries, acknowledgements };
}
