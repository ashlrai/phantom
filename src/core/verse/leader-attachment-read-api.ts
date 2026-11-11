/**
 * Leader attachment read — serves one stored screenshot back to the desktop
 * thread, which renders the `[screenshot: <path>]` marker as an image.
 *
 *   GET /api/verse/leader/attachment/<sha256-first-16>.<png|jpg|webp>
 *                                     → the image bytes
 *
 * Gated exactly like the POST that wrote the file (leader-attachment-api.ts):
 * 404 without dispatch, then the x-ashlr-token check. The web UI reads the
 * bytes with that header in an authenticated fetch and shows a blob URL — the
 * same shape as the Browser/Computer screenshot answers — so no query
 * credential is minted for an <img> to carry. The remote (phone) gateway does
 * not list this path, so it stays denied there, same as the POST.
 *
 * Only the stored name shape is reachable: a strict regex refuses every other
 * name before any path is joined, the file must lstat as a regular file
 * inside `<runs dir>/inbox-attachments` (a symlink — or a symlinked dir — is
 * refused), and the magic bytes are re-checked against the extension's type.
 */
import { lstat, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { sendJson } from '../web/api.js';
import { headerValue, safeEqual } from '../web/read-session.js';
import {
  LEADER_ATTACHMENT_MAX_BYTES,
  LEADER_ATTACHMENT_NAME_RE,
  MIME_BY_EXT,
  leaderAttachmentDir,
  matchesMagic,
} from './leader-attachment-api.js';
import type { VerseApiContext } from './verse-api.js';

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'not found' });
}

/** `name` is the path segment after `/api/verse/leader/attachment/`. */
export async function handleLeaderAttachmentRead(
  ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  name: string,
): Promise<boolean> {
  if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  if (!ctx.allowDispatch) { notFound(res); return true; }
  if (!safeEqual(headerValue(req, 'x-ashlr-token'), ctx.token)) {
    sendJson(res, 401, { error: 'unauthorized: missing or invalid x-ashlr-token' });
    return true;
  }
  const match = LEADER_ATTACHMENT_NAME_RE.exec(name);
  if (match === null) { notFound(res); return true; }
  const mime = MIME_BY_EXT[match[1] as keyof typeof MIME_BY_EXT];

  const dir = leaderAttachmentDir();
  // The regex admits no separators or dot segments, so this join stays inside
  // `dir`; lstat (never stat) then proves the dir and the file are real, not links.
  const abs = join(dir, name);
  try {
    const dirStat = await lstat(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      notFound(res);
      return true;
    }
    const st = await lstat(abs);
    if (!st.isFile() || st.isSymbolicLink() || st.size > LEADER_ATTACHMENT_MAX_BYTES) {
      notFound(res);
      return true;
    }
  } catch {
    notFound(res);
    return true;
  }

  let body: Buffer;
  try {
    body = await readFile(abs);
  } catch {
    notFound(res);
    return true;
  }
  // Re-check after the read: the file may have grown between lstat and read.
  if (body.length > LEADER_ATTACHMENT_MAX_BYTES) {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'image is over 8 MiB' });
    return true;
  }
  if (!matchesMagic(mime, body)) {
    sendJson(res, 415, { error: `the stored bytes are not a ${mime} image` });
    return true;
  }
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': String(body.length),
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(body);
  return true;
}
