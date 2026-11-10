import { ApiError } from '../../../data/client.js';

/** The owner policy file, read from the account home (not $HOME) by the leader network. */
export const COMMS_TOML_PATH = '~/.ashlr/comms.toml';
export const COMMS_CONFIRM_LINE = 'confirmedByMason = true';

export const INBOX_HELD_SENTENCE = 'Held: comms approval is not confirmed, so this did not reach MASON-INBOX.';

/** The inbox route answers 403 `{ ok: false, status: 'drafted', reason }` while comms.toml is unconfirmed. */
export function inboxHeld(error: unknown): { held: true; reason: string } | null {
  if (!(error instanceof ApiError) || error.status !== 403) return null;
  const body = error.body;
  if (typeof body !== 'object' || body === null || (body as { status?: unknown }).status !== 'drafted') return null;
  return { held: true, reason: error.detail ?? INBOX_HELD_SENTENCE };
}
