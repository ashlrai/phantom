/**
 * Leader attachment route: one pasted or dropped screenshot for the Leader box.
 *
 *   POST /api/verse/leader/attachment   raw image body (Content-Type image/png,
 *                                       image/jpeg or image/webp, max 8 MiB)
 *                                     → {path, sha256, bytes, type}
 *
 * The bytes land on local disk only, at <runs dir>/inbox-attachments/
 * <sha256-first-16>.<ext> (dir 0700, file 0600; the same bytes keep the same
 * name and are not written twice). The returned path is what the composer
 * appends to the message so agents can open the file. Gated exactly like the
 * Leader thread send: 404 without dispatch, then the x-ashlr-token check. The
 * remote (phone) gateway does not list this path, so it stays denied there.
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, open, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sendJson } from '../web/api.js';
import { headerValue, safeEqual } from '../web/read-session.js';
import type { VerseApiContext } from './verse-api.js';

export const VERSE_LEADER_ATTACHMENT_PATH = '/api/verse/leader/attachment';
export const LEADER_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
type AttachmentType = keyof typeof EXT;

/** Magic bytes must agree with the declared type. */
function matchesMagic(type: AttachmentType, b: Buffer): boolean {
  if (type === 'image/png') return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  return b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
}

/** Collect the raw body; null once it passes the cap (the rest is drained, not kept). */
function readRaw(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      total += b.length;
      if (total <= LEADER_ATTACHMENT_MAX_BYTES) chunks.push(b);
      else chunks.length = 0;
    });
    req.on('end', () => resolve(total > LEADER_ATTACHMENT_MAX_BYTES ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function runsDir(): string {
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

export async function handleLeaderAttachment(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, method: string): Promise<boolean> {
  if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
  if (!safeEqual(headerValue(req, 'x-ashlr-token'), ctx.token)) {
    sendJson(res, 401, { error: 'unauthorized: missing or invalid x-ashlr-token' });
    return true;
  }
  if ((req.url ?? '').includes('?')) { sendJson(res, 400, { code: 'VERSE_INVALID', error: 'this route takes no query parameters' }); return true; }
  const type = headerValue(req, 'content-type').split(';')[0]!.trim().toLowerCase();
  if (!Object.hasOwn(EXT, type)) { sendJson(res, 415, { error: 'Content-Type must be image/png, image/jpeg or image/webp' }); return true; }
  const declared = Number(headerValue(req, 'content-length'));
  if (Number.isFinite(declared) && declared > LEADER_ATTACHMENT_MAX_BYTES) { sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'image is over 8 MiB' }); return true; }
  const body = await readRaw(req).catch(() => null);
  if (body === null) { sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'image is over 8 MiB' }); return true; }
  const kind = type as AttachmentType;
  if (!matchesMagic(kind, body)) { sendJson(res, 415, { error: `the bytes are not a ${type} image` }); return true; }

  const sha256 = createHash('sha256').update(body).digest('hex');
  const dir = join(runsDir(), 'inbox-attachments');
  const path = join(dir, `${sha256.slice(0, 16)}.${EXT[kind]}`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const existing = await stat(path).then((s) => s.size, () => -1);
    if (existing !== body.length) {
      const file = await open(path, 'w', 0o600);
      try { await file.writeFile(body); } finally { await file.close(); }
      await chmod(path, 0o600);
    }
  } catch {
    sendJson(res, 500, { error: 'could not store the image' });
    return true;
  }
  sendJson(res, 200, { path, sha256, bytes: body.length, type });
  return true;
}
