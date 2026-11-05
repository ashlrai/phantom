/** Read-only listing of chief-of-staff reply drafts and their delivery claims. Never writes. */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CosDraft } from './intake.js';

export type CosDraftDelivery = 'pending' | 'sending' | 'sent' | 'uncertain';
export interface CosDraftEntry {
  id: string;
  channel: string;
  senderId: string;
  threadId?: string;
  text: string;
  digest: string;
  delivery: CosDraftDelivery;
  /** Draft file mtime, ISO. */
  draftedAt: string;
}
export interface CosDraftList { v: 1; drafts: CosDraftEntry[]; malformed: number }

export const COS_DRAFTS_DEFAULT_LIMIT = 50;
export const COS_DRAFTS_MAX_LIMIT = 200;
const DRAFT_FILE = /^(cos-[a-f0-9]{32})\.json$/;
const str = (v: unknown): v is string => typeof v === 'string';

function parseDraft(raw: string, id: string): CosDraft | undefined {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return undefined; }
  if (typeof v !== 'object' || v === null) return undefined;
  const d = v as Record<string, unknown>;
  const o = d.origin as Record<string, unknown> | null | undefined;
  if (d.id !== id || !str(d.text) || !str(d.digest) || !/^[a-f0-9]{64}$/.test(d.digest) ||
    typeof o !== 'object' || o === null || !str(o.channel) || !str(o.senderId) ||
    (o.threadId !== undefined && !str(o.threadId))) return undefined;
  return d as unknown as CosDraft;
}

async function deliveryOf(dir: string, id: string): Promise<CosDraftDelivery> {
  let raw: string;
  try { raw = await readFile(join(dir, `${id}.delivery.json`), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'pending';
    return 'uncertain';
  }
  // A claim file exists, so the draft is never 'pending' again. An unreadable
  // or unknown state needs reconciliation, the same as a failed send.
  try {
    const state = (JSON.parse(raw) as { state?: unknown }).state;
    return state === 'sending' || state === 'sent' || state === 'uncertain' ? state : 'uncertain';
  } catch { return 'uncertain'; }
}

/** Newest first by draft mtime. `malformed` counts draft-named files that fail the CosDraft shape. */
export async function listCosDrafts(opts: { runsDir?: string; limit?: number } = {}): Promise<CosDraftList> {
  const root = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const dir = join(root, 'cos');
  const limit = Math.min(COS_DRAFTS_MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? COS_DRAFTS_DEFAULT_LIMIT)));
  let names: string[];
  try { names = await readdir(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, drafts: [], malformed: 0 };
    throw error;
  }
  let malformed = 0;
  const found: Array<{ entry: CosDraftEntry; mtimeMs: number }> = [];
  for (const name of names) {
    const id = DRAFT_FILE.exec(name)?.[1];
    if (id === undefined) continue; // includes `<id>.delivery.json`
    let draft: CosDraft | undefined;
    let mtimeMs = 0;
    try {
      const path = join(dir, name);
      const info = await stat(path);
      if (!info.isFile()) { malformed++; continue; }
      mtimeMs = info.mtimeMs;
      draft = parseDraft(await readFile(path, 'utf8'), id);
    } catch { draft = undefined; }
    if (!draft) { malformed++; continue; }
    found.push({ mtimeMs, entry: { id, channel: draft.origin.channel, senderId: draft.origin.senderId,
      ...(draft.origin.threadId !== undefined ? { threadId: draft.origin.threadId } : {}),
      text: draft.text, digest: draft.digest, delivery: await deliveryOf(dir, id),
      draftedAt: new Date(mtimeMs).toISOString() } });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.entry.id < b.entry.id ? -1 : 1));
  return { v: 1, drafts: found.slice(0, limit).map(f => f.entry), malformed };
}
