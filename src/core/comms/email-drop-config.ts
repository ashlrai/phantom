import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { readSource } from '../fleet/runs-parked-queue.js';

export const EMAIL_DROP_CONFIG_FILE = join('queue', 'email-drop.json');
const MAX_CONFIG_BYTES = 16 * 1024;

export interface EmailDropConfig {
  v: 1;
  /** Saved configs enable polling by default; false pauses inbound and outbound. */
  enabled?: boolean;
  inboxDir: string;
  outboxDir?: string;
  processedDir?: string;
  from: string[];
  /** Opt-in: `phm comms cycle` sends queued reply .eml files via Mail.app. Absent means off. */
  sendReplies?: boolean;
}

/** Match the email-drop CLI's existing address normalization. */
export function normalizeEmailDropAddress(value: string): string | null {
  const address = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(address) ? address : null;
}

function validConfig(value: unknown): value is EmailDropConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  const directory = (dir: unknown): boolean => typeof dir === 'string' && isAbsolute(dir) && !dir.includes('\0');
  return Object.keys(config).every((key) => ['v', 'enabled', 'inboxDir', 'outboxDir', 'processedDir', 'from', 'sendReplies'].includes(key)) &&
    config.v === 1 && (config.enabled === undefined || typeof config.enabled === 'boolean') && directory(config.inboxDir) &&
    (config.outboxDir === undefined || directory(config.outboxDir)) &&
    (config.processedDir === undefined || directory(config.processedDir)) &&
    (config.sendReplies === undefined || typeof config.sendReplies === 'boolean') &&
    Array.isArray(config.from) && config.from.length >= 1 && config.from.length <= 32 &&
    config.from.every((address: unknown) => typeof address === 'string' &&
      normalizeEmailDropAddress(address) === address &&
      /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(address));
}

export async function readEmailDropConfig(runsDir: string): Promise<{ state: 'missing' | 'invalid' | 'ok'; config?: EmailDropConfig; path: string }> {
  const path = join(runsDir, EMAIL_DROP_CONFIG_FILE);
  try {
    const source = await readSource(path, MAX_CONFIG_BYTES, false);
    if (source.state !== 'healthy') return { state: source.state === 'missing' ? 'missing' : 'invalid', path };
    const config: unknown = JSON.parse(source.text);
    return validConfig(config) ? { state: 'ok', config, path } : { state: 'invalid', path };
  } catch {
    return { state: 'invalid', path };
  }
}

export async function writeEmailDropConfig(runsDir: string, config: EmailDropConfig): Promise<string> {
  if (!validConfig(config)) throw new Error('invalid email-drop config');
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_CONFIG_BYTES) throw new Error('email-drop config too large');
  const path = join(runsDir, EMAIL_DROP_CONFIG_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

/** A folder any other local user can write could inject or swap .eml files. */
export function isOtherWritable(path: string): boolean {
  try { return (statSync(path).mode & 0o002) !== 0; }
  catch { return false; } // missing dirs are handled by the normal empty-pass path
}

export type EmailDropInboxState = 'ok' | 'missing' | 'not-directory' | 'unreadable';

export interface EmailDropInboxPending {
  state: EmailDropInboxState;
  /** Other-writable: `runEmailDropOnce` refuses the whole pass, so entries stay pending until permissions are fixed. */
  unsafe: boolean;
  /** `*.eml` directory entries still awaiting the pass — the same case-insensitive suffix rule the pass applies, never a parsed message. */
  pending: number;
  /** Newest entry mtime in epoch ms — filesystem evidence of the freshest arrival; null when no entry could be stat'ed. */
  newestAtMs: number | null;
}

/**
 * Read-only listing of the drop inbox: which `*.eml` entries still await
 * `runEmailDropOnce`, without opening a single message. The same suffix rule,
 * unsafe-folder check and never-follow-a-link stat discipline the pass uses.
 * Every listed entry counts as pending — the pass fails unreadable, oversized
 * or non-regular entries and leaves them in place — while a stat failure only
 * costs that entry's mtime, never its count.
 */
export function readEmailDropInbox(dir: string): EmailDropInboxPending {
  const empty = (state: EmailDropInboxState, unsafe = false): EmailDropInboxPending =>
    ({ state, unsafe, pending: 0, newestAtMs: null });
  let stat;
  try {
    stat = statSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return empty(code === 'ENOENT' ? 'missing' : code === 'ENOTDIR' ? 'not-directory' : 'unreadable');
  }
  if (!stat.isDirectory()) return empty('not-directory');
  const unsafe = isOtherWritable(dir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.eml')).sort();
  } catch {
    return empty('unreadable', unsafe);
  }
  let newestAtMs: number | null = null;
  for (const name of names) {
    try {
      const mtime = lstatSync(join(dir, name)).mtimeMs;
      if (Number.isFinite(mtime) && (newestAtMs === null || mtime > newestAtMs)) newestAtMs = mtime;
    } catch { /* a vanished or unreadable entry keeps its pending count; only its mtime is lost */ }
  }
  return { state: 'ok', unsafe, pending: names.length, newestAtMs };
}
