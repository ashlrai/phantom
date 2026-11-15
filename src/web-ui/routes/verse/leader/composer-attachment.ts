/**
 * routes/verse/leader/composer-attachment.ts — the Leader box's one-screenshot
 * attachment: pick an image from a paste or drop, check it against the
 * server's limits, upload it, and add its `[screenshot: <path>]` line to the
 * message. The image stays on this machine (the route writes local disk only).
 */
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { LEADER_MESSAGE_MAX } from './thread-model.js';

/** Mirrors core/verse/leader-attachment-api.ts. */
export const ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_PATH = '/api/verse/leader/attachment';

export interface UploadedAttachment { path: string; sha256: string; bytes: number; type: string }

/** The first image in a ClipboardEvent's or DragEvent's DataTransfer, else null. */
export function pickImage(data: Pick<DataTransfer, 'files' | 'items'> | null | undefined): File | null {
  if (!data) return null;
  for (const file of Array.from(data.files ?? [])) if (file.type.startsWith('image/')) return file;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/** An error sentence for a file the server would refuse; null when it is fine. */
export function checkImage(file: { type: string; size: number }): string | null {
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(file.type)) return 'Only PNG, JPEG or WebP screenshots can be attached.';
  if (file.size === 0) return 'That image is empty.';
  if (file.size > ATTACHMENT_MAX_BYTES) return 'That image is over 8 MiB.';
  return null;
}

export type AppendResult = { text: string; error?: undefined } | { error: string; text?: undefined };

/** Add the `[screenshot: <path>]` line; an error string when it would pass the message limit. */
export function appendAttachmentRef(text: string, path: string): AppendResult {
  const line = `[screenshot: ${path}]`;
  const next = text.trim().length === 0 ? line : `${text.replace(/\s+$/, '')}\n${line}`;
  if (next.length > LEADER_MESSAGE_MAX) return { error: `The message is too long to add the screenshot (limit ${LEADER_MESSAGE_MAX.toLocaleString('en-US')} characters).` };
  return { text: next };
}

export function formatBytes(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Upload one checked image with the mutation token; throws an Error whose message is the server's reason. */
export async function uploadAttachment(file: File, signal?: AbortSignal): Promise<UploadedAttachment> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const res = await fetch(ATTACHMENT_PATH, {
    method: 'POST', credentials: 'same-origin', signal, body: file,
    headers: { 'content-type': file.type, 'x-ashlr-token': token },
  });
  touchMutationHold();
  if (!res.ok) {
    let reason = `The server answered HTTP ${res.status}.`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error) reason = body.error;
    } catch { /* keep the status sentence */ }
    throw new Error(reason);
  }
  const body = (await res.json()) as Partial<UploadedAttachment>;
  if (typeof body.path !== 'string') throw new Error('The server did not return a file path.');
  return body as UploadedAttachment;
}
