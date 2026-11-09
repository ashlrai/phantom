/** Pending outbound email drafts the Comms agent wrote (GET/POST /api/verse/comms/inbox/email-drafts). */
export const EMAIL_DRAFTS_PATH = '/api/verse/comms/inbox/email-drafts';
export const EMAIL_APPROVE_PATH = `${EMAIL_DRAFTS_PATH}/approve`;
export const EMAIL_REJECT_PATH = `${EMAIL_DRAFTS_PATH}/reject`;

export interface EmailDraft {
  id: string;
  to: string;
  subject: string;
  body: string;
  truncated: boolean;
  digest: string;
  createdAt: string;
}

const ID_RE = /^d-[0-9a-f]{16}$/;
// The server labels the digest `sha256:` because its JSON scrubber redacts a bare 64-hex string.
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readDraft(row: unknown): EmailDraft | null {
  if (!isRecord(row)) return null;
  const { id, to, subject, body, digest, createdAt, truncated } = row;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) return null;
  if (typeof to !== 'string' || !to || typeof subject !== 'string' || typeof body !== 'string' || typeof createdAt !== 'string') return null;
  if (truncated !== undefined && typeof truncated !== 'boolean') return null;
  return { id, to, subject, body, truncated: truncated === true, digest, createdAt };
}

/** Strict narrowing: rows that fail the shape are dropped, never repaired. */
export function readEmailDrafts(data: unknown): EmailDraft[] {
  if (!isRecord(data) || data.v !== 1 || !Array.isArray(data.drafts)) return [];
  return data.drafts.map(readDraft).filter((draft): draft is EmailDraft => draft !== null);
}

/** One plain sentence for every decision response. `body` is the parsed JSON body, or `{ code }` from an ApiError. */
export function emailDraftOutcome(status: number, body: unknown): string {
  const record = isRecord(body) ? body : {};
  const word = typeof record.status === 'string' ? record.status : typeof record.code === 'string' ? record.code : '';
  if (status === 200 && word === 'approved') return 'Approved. Approval records your decision; it does not send.';
  if (status === 200 && word === 'rejected') return 'Rejected.';
  if (status === 409 && word === 'stale') return 'The draft changed; review it again.';
  if (status === 409 && word === 'already-decided') return 'Already decided.';
  return 'Could not save your decision. Try again.';
}
