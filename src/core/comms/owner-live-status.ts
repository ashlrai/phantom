/**
 * Why each phone channel is on or off, and the one step that changes it
 * (`phm owner-live status`, schema owner-live.status.v1). Built only on the
 * owner adapter gate (adapterStatus) plus the same confirmation and team
 * checks sendOwnerReply enforces, so the answer here is the answer the send
 * path gives. Ids, numbers, addresses and tokens are never returned: every
 * binding reads "set" or "not set".
 */
import { OWNER_SECRET_HANDLES, adapterStatus, busIdentity, type OwnerSecretChannel, type OwnerThreadSettings } from './owner-channel.js';
import type { OwnerChannel } from './leader-mailbox.js';
import type { OwnerPairStatusV1 } from './owner-pair.js';

export const PHONE_CHANNELS = ['telegram', 'email', 'imessage', 'slack'] as const satisfies readonly OwnerChannel[];
export type PhoneChannel = typeof PHONE_CHANNELS[number];
export type OwnerLiveState = 'on' | 'off' | 'not-set-up';

export interface OwnerLiveChannelStatus {
  channel: PhoneChannel;
  state: OwnerLiveState;
  /** One plain sentence: why it is on or off. */
  reason: string;
  /** The config file and key (or binding) that decides it. */
  decidedBy: { file: string; key: string; value: 'set' | 'not set' }[];
  /** The single step that turns it on; null when already on. */
  nextStep: string | null;
}

export interface OwnerLiveStatusV1 {
  schema: 'owner-live.status.v1';
  /** True when at least one channel is on. */
  anyOn: boolean;
  /** One line for a panel row, e.g. "Phone updates: off (iMessage not set up)". */
  line: string;
  channels: OwnerLiveChannelStatus[];
  /** The iMessage pairing, when the caller read it: not paired / waiting for YES / paired. */
  pair?: OwnerPairStatusV1;
}

const NETWORK = '~/.ashlr/agent-network.toml';
const ADAPTERS = '~/.ashlr/comms/owner-adapters.toml';
const COMMS = '~/.ashlr/comms.toml';
const NAME: Record<PhoneChannel, string> = { telegram: 'Telegram', email: 'Email', imessage: 'iMessage', slack: 'Slack' };
const ownerKey = (channel: PhoneChannel): string => `[mason] { channel = "${channel}", id = <Mason's ${NAME[channel]} id> }`;

/** True when the owner id for the channel is also a team identity, as sendOwnerReply requires. */
function bound(channel: PhoneChannel, settings: OwnerThreadSettings): boolean {
  const id = settings.owners[channel];
  if (!id) return false;
  const want = busIdentity(channel, id);
  return settings.team.some(t => t.channel === want.channel && t.id === id);
}

export function readOwnerLiveStatus(settings: OwnerThreadSettings, hold: { halted: boolean; paused: boolean }, pair?: OwnerPairStatusV1): OwnerLiveStatusV1 {
  const channels = PHONE_CHANNELS.map((channel): OwnerLiveChannelStatus => {
    const gate = adapterStatus(channel, settings, hold.halted, hold.paused);
    const idSet = Boolean(settings.owners[channel]);
    const decidedBy: OwnerLiveChannelStatus['decidedBy'] = [
      { file: NETWORK, key: ownerKey(channel), value: idSet ? 'set' : 'not set' },
    ];
    if (channel === 'imessage') {
      decidedBy.push({ file: ADAPTERS, key: '[imessage] bridge = "loopback"', value: settings.imessageBridge === 'loopback' ? 'set' : 'not set' });
    } else {
      decidedBy.push({ file: ADAPTERS, key: `[${channel}] secretHandle = "${OWNER_SECRET_HANDLES[channel as OwnerSecretChannel]}"`, value: settings.secretHandles[channel as OwnerSecretChannel] ? 'set' : 'not set' });
    }
    decidedBy.push({ file: COMMS, key: 'confirmed = true (Mason confirms the owner)', value: settings.confirmed ? 'set' : 'not set' });
    const base = { channel, decidedBy };
    if (hold.halted || hold.paused) {
      return { ...base, state: 'off', reason: `${NAME[channel]} is held: ${gate.reason}`, nextStep: 'Remove ~/.ashlr/KILL or resume comms.' };
    }
    if (channel === 'imessage' && settings.imessageBridge === 'loopback' && !idSet) {
      // The bridge is on; only Mason's own handle is missing. Nothing is sent until it is paired.
      if (pair?.state === 'waiting') return { ...base, state: 'not-set-up', reason: 'iMessage waiting for your YES', nextStep: 'Reply YES to the text on your phone' };
      return { ...base, state: 'not-set-up', reason: 'iMessage on, but no verified Mason handle: run phm owner pair imessage', nextStep: 'phm owner pair imessage' };
    }
    if (!gate.configured) {
      return { ...base, state: 'not-set-up', reason: `${NAME[channel]} not set up: ${gate.reason.replace(/\.$/, '')}.`, nextStep: gate.nextStep };
    }
    if (!settings.confirmed) {
      return { ...base, state: 'off', reason: `${NAME[channel]} is set up but Mason has not confirmed it.`, nextStep: `Set confirmed = true in ${COMMS}.` };
    }
    if (!bound(channel, settings)) {
      return { ...base, state: 'off', reason: `${NAME[channel]} owner id is not in the team list, so nothing is sent.`, nextStep: `Add the same ${NAME[channel]} id under [team] in ${NETWORK}.` };
    }
    return { ...base, state: 'on', reason: `${NAME[channel]} is on and bound to Mason.`, nextStep: null };
  });
  const anyOn = channels.some(c => c.state === 'on');
  // iMessage is the route Mason reads first, so it names the row when it is off.
  const worst = channels.find(c => c.channel === 'imessage' && c.state !== 'on') ?? channels.find(c => c.state === 'not-set-up') ?? channels.find(c => c.state !== 'on');
  const waiting = worst?.channel === 'imessage' && worst.reason === 'iMessage waiting for your YES';
  const line = anyOn
    ? `Phone updates: on (${channels.filter(c => c.state === 'on').map(c => NAME[c.channel]).join(', ')})`
    : `Phone updates: off (${waiting ? 'iMessage waiting for your YES' : worst ? `${NAME[worst.channel]} ${worst.state === 'not-set-up' ? 'not set up' : 'held'}` : 'no channels'})`;
  return { schema: 'owner-live.status.v1', anyOn, line, channels, ...(pair ? { pair } : {}) };
}
