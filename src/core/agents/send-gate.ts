/** Fail-closed gates for local probes and outbound agent sends. Never delivers. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isPaused } from '../comms/pause.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  parseCommsConfirmation, parseTeamIdentities, checkSendPolicy,
  type ChannelId, type DeliverResult, type TeamIdentity,
} from './channel-policy.js';

export function localWriteGate(): DeliverResult | null {
  if (killSwitchOn()) return { status: 'refused', reason: 'Kill switch is on.' };
  if (isPaused()) return { status: 'refused', reason: 'Communications are paused.' };
  return null;
}

export function readLocalSendPolicy(): { teamIdentities: TeamIdentity[]; confirmedByMason: boolean } {
  const directory = join(homedir(), '.ashlr');
  const read = (name: string): string => {
    const result = readStableRegularFile(join(directory, name), {
      anchorPath: directory, maxFileBytes: 64 * 1024, remainingBytes: 64 * 1024,
    });
    return result.ok ? result.text : '';
  };
  return {
    teamIdentities: parseTeamIdentities(read('agent-network.toml')),
    confirmedByMason: parseCommsConfirmation(read('comms.toml')),
  };
}

/** Policy, pause, kill, and secret-shaped text. A null result means the send may proceed. */
export function outboundGate(input: {
  channel: ChannelId;
  recipientId: string;
  text?: string;
  teamIdentities?: readonly TeamIdentity[];
  confirmedByMason?: boolean;
  external?: boolean;
}): DeliverResult | null {
  const blocked = localWriteGate();
  if (blocked) return blocked;
  if (input.text !== undefined && scrubSecrets(input.text) !== input.text) {
    return { status: 'refused', reason: 'Message text is not sendable.' };
  }
  const loaded = input.teamIdentities === undefined || input.confirmedByMason === undefined
    ? readLocalSendPolicy() : null;
  const decision = checkSendPolicy({
    channel: input.channel,
    recipients: [input.recipientId],
    teamIdentities: input.teamIdentities ?? loaded!.teamIdentities,
    confirmedByMason: input.confirmedByMason ?? loaded!.confirmedByMason,
    external: input.external === true,
  });
  return decision.status === 'sent' ? null : decision;
}
