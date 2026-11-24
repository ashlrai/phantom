import { scrubSecrets } from '../../../core/util/scrub-secrets.js';

/** Existing native channel receiver caps the whole JSON message, not just text. */
export const OWNER_SHARE_MAX_CHARS = 6000;
export type OwnerDraft = { ok: true; json: string } | { ok: false; reason: string };
export function prepareOwnerDraft(channel: string, thread: string, text: string): OwnerDraft {
  if (typeof channel !== 'string' || typeof thread !== 'string' || typeof text !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}(?![\s\S])/.test(channel) ||
      !/^(outcome|run):[A-Za-z0-9][A-Za-z0-9._:-]{0,119}(?![\s\S])/.test(thread)) {
    return { ok: false, reason: 'Select an exact channel and run or outcome first.' };
  }
  if (!text.trim()) return { ok: false, reason: 'Write a note to prepare a draft.' };
  if ([channel, thread, text].some(value => scrubSecrets(value) !== value)) {
    return { ok: false, reason: 'Remove credential-shaped content before copying.' };
  }
  const json = JSON.stringify({ kind: 'agent-chat.share', channel, thread, text });
  if (json.length > OWNER_SHARE_MAX_CHARS) return { ok: false, reason: 'Shorten the note: the complete JSON must fit within 6,000 characters.' };
  if (scrubSecrets(json) !== json) return { ok: false, reason: 'Remove credential-shaped content before copying.' };
  return { ok: true, json };
}
