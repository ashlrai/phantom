/**
 * Hands an already-authenticated channel envelope to the forum. The channel
 * receiver has already checked the sender. This module does not open Telegram,
 * email, or the phone. It no-ops until a forum file exists.
 */
import { forumIngestEnabled, forumRoot, ingestVerifiedHuman } from './forum/service.js';

export async function maybeIngestForum(message: { channel: string; verifiedSenderId: string; body: string }): Promise<void> {
  if (!forumIngestEnabled()) return;
  try {
    await ingestVerifiedHuman(message, { root: forumRoot(), signLocally: false });
  } catch {
    // The inbox receipt already landed. A forum miss must not undo it.
  }
}
