import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost, readFailureReason } from '../../../data/client.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import { parseBusCommand } from './composer-text.js';

export function buildMasonEnvelope({ to, text, now, random }: { to: string; text: string; now: number; random: number }) {
  return {
    id: `mason-composer-${now}-${Math.floor(random * 0x100000000).toString(16).padStart(8, '0')}`,
    from: 'mason',
    to,
    priority: 'P1' as const,
    ttl: 3600,
    body: { text, source: 'Phantom desktop composer', at: new Date(now).toISOString() },
  };
}

export async function runBusCommand(draft: string): Promise<{ ok: boolean; text: string }> {
  const command = parseBusCommand(draft);
  if (!command) return { ok: false, text: 'Use /bus <to> <text> to post to the agent bus.' };
  if ('error' in command) return { ok: false, text: command.error };
  try {
    const token = getMutationToken();
    if (!token) throw new VerseMutationLockedError();
    const envelope = buildMasonEnvelope({ ...command, now: Date.now(), random: Math.random() });
    await apiPost('/api/verse/agent-bus', envelope, token);
    touchMutationHold();
    return { ok: true, text: `Posted to ${command.to} on the bus · ${envelope.id}` };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { ok: false, text: 'Agent bus is off: fleet dispatch switch is down' };
    if (error instanceof ApiError && error.status === 503) return { ok: false, text: 'Agent bus store unavailable' };
    return { ok: false, text: error instanceof VerseMutationLockedError ? error.message : readFailureReason(error) };
  }
}
