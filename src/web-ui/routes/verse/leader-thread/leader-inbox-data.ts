import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiPost } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';

/** The desktop shares the durable inbox, authenticated receiver and send policy with the CLI. */
export async function sendLeaderInboxMessage(text: string): Promise<void> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  await apiPost('/api/verse/leader/inbox', { text, source: 'Phantom desktop' }, token);
  touchMutationHold();
}
