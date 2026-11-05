/**
 * M137: iMessage bidirectional channel adapter — macOS-native.
 *
 * Provides these primitives:
 *   sendIMessage(text, cfg)         - osascript send via execFile (never a shell)
 *   pollInboundReplies(sinceMs, cfg) - chat.db SELECT, read-only, apple-epoch aware
 *   pollInboundSince(rowid, cfg)    - intake read: allowlist + message.ROWID cursor
 *   readCursor / writeCursor        - ROWID cursor under ~/.ashlr-runs/imessage (0600)
 *   probeChatDb / buildDoctorReport - local, read-only readiness evidence
 *
 * Strict no-op unless BOTH hold: cfg.comms.enabled === true AND
 * cfg.comms.imessageHandle is set. Mirrors desktop-notify.ts conventions:
 *   - execFile (never exec/shell)
 *   - never throws
 *   - 5s timeout on osascript
 *   - handle-filtered output only (ignore all other conversations)
 *
 * macOS permissions required:
 *   - Automation → Messages  (to call osascript tell application "Messages")
 *   - Full Disk Access        (to read ~/Library/Messages/chat.db)
 *
 * The text passed to sendIMessage is delivered to the AppleScript engine as a
 * quoted argument with all special characters escaped — the AppleScript
 * interpreter never sees raw user-controlled bytes in an interpolated position.
 *
 * Apple epoch: Messages stores `date` as nanoseconds since 2001-01-01T00:00:00Z.
 *   unixMs = appleNs / 1_000_000 + 978_307_200_000
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { AshlrConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEND_TIMEOUT_MS = 5_000;
const APPLE_EPOCH_OFFSET_MS = 978_307_200_000; // ms between Unix epoch and Apple epoch (2001-01-01)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InboundMsg {
  text: string;
  ts: number;   // unix ms
  handle: string;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** True when the comms channel is properly configured and enabled. */
export function commsEnabled(cfg: AshlrConfig): boolean {
  const c = cfg.comms;
  return c?.enabled === true && typeof c.imessageHandle === 'string' && c.imessageHandle.length > 0;
}

// ---------------------------------------------------------------------------
// AppleScript escaping
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion inside an AppleScript double-quoted
 * string literal. We escape backslashes, double-quotes, and collapse newlines.
 * This is the ONLY escaping context — the entire text is passed as a single
 * -e script literal to osascript, not via a shell. execFile guarantees the
 * osascript process receives the literal string; no shell expansion occurs.
 */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

// ---------------------------------------------------------------------------
// sendIMessage
// ---------------------------------------------------------------------------

/**
 * Send an iMessage to cfg.comms.imessageHandle. Uses execFile + osascript
 * (darwin only). Never throws; returns {ok:false} on any failure or when
 * disabled/misconfigured.
 *
 * Injection safety: the message text is embedded inside an AppleScript
 * double-quoted string with escapeAppleScript() applied. execFile passes the
 * entire -e script as a single argv element — no shell tokenisation occurs.
 */
export function sendIMessage(text: string, cfg: AshlrConfig): Promise<{ ok: boolean }> {
  if (!commsEnabled(cfg)) return Promise.resolve({ ok: false });
  if (process.platform !== 'darwin') return Promise.resolve({ ok: false });

  const handle = cfg.comms!.imessageHandle!;
  const service = cfg.comms?.service ?? 'iMessage';

  const safeText = escapeAppleScript(text);
  const safeHandle = escapeAppleScript(handle);
  const safeService = escapeAppleScript(service);

  // Use `1st service whose service type = iMessage` instead of `of service "iMessage"` by name.
  // The by-name form errors -1728 on macOS 13+ when the service name doesn't match exactly.
  // When a custom service name is configured (non-default), fall back to the by-name form.
  const useTypeSelector = service === 'iMessage';
  const serviceClause = useTypeSelector
    ? 'of (1st service whose service type = iMessage)'
    : `of service "${safeService}"`;
  const script =
    `tell application "Messages" to send "${safeText}" to buddy "${safeHandle}" ` +
    serviceClause;

  return new Promise<{ ok: boolean }>((resolve) => {
    try {
      execFile('osascript', ['-e', script], { timeout: SEND_TIMEOUT_MS }, (err, _stdout, stderr) => {
        recordLastSend(err ? sendErrorCode(`${stderr ?? ''}${err.message ?? ''}`) ?? 'error' : null);
        resolve({ ok: !err });
      });
    } catch {
      resolve({ ok: false });
    }
  });
}

// ---------------------------------------------------------------------------
// pollInboundReplies — chat.db read
// ---------------------------------------------------------------------------

// One-time hint flag — emit to stderr once if Full Disk Access is not granted.
let _hintEmitted = false;

/**
 * Convert an Apple-epoch nanoseconds integer (from chat.db `date` column) to
 * a Unix millisecond timestamp.
 */
export function appleNsToUnixMs(appleNs: number): number {
  return appleNs / 1_000_000 + APPLE_EPOCH_OFFSET_MS;
}

/**
 * Read recent inbound messages from ~/Library/Messages/chat.db using the
 * sqlite3 CLI (READ-ONLY mode). Filters to messages from cfg.comms.imessageHandle
 * only (is_from_me=0). Returns [] on any failure (unreadable db, missing
 * permissions, no sqlite3 binary, wrong platform). Never throws.
 *
 * Returns only messages whose timestamp (Apple epoch ns → unix ms) > sinceMs.
 *
 * Full Disk Access note: if chat.db is locked/unreadable, emits a one-time
 * hint to stderr and returns []. The caller (dispatch) should surface this
 * to the user via `ashlr comms status`.
 */
export function pollInboundReplies(sinceMs: number, cfg: AshlrConfig): Promise<InboundMsg[]> {
  if (!commsEnabled(cfg)) return Promise.resolve([]);
  if (process.platform !== 'darwin') return Promise.resolve([]);

  const handle = cfg.comms!.imessageHandle!;
  const dbPath = join(homedir(), 'Library', 'Messages', 'chat.db');

  if (!existsSync(dbPath)) {
    return Promise.resolve([]);
  }

  // Apple epoch threshold: convert sinceMs back to Apple ns for the SQL WHERE clause.
  // appleNs = (unixMs - APPLE_EPOCH_OFFSET_MS) * 1_000_000
  const appleNsThreshold = (sinceMs - APPLE_EPOCH_OFFSET_MS) * 1_000_000;

  // SQL query: join message + handle, filter is_from_me=0 and matching handle id.
  // We use single-quotes inside the SQL so no shell escaping of the handle is needed —
  // the entire SQL is passed as a single argv element to sqlite3 via execFile.
  // The handle value is embedded with basic SQL-string escaping (single-quote doubling).
  const safeHandle = handle.replace(/'/g, "''");
  const sql =
    `SELECT m.text, m.date FROM message m ` +
    `JOIN handle h ON m.handle_id = h.ROWID ` +
    `WHERE m.is_from_me = 0 ` +
    `AND h.id = '${safeHandle}' ` +
    `AND m.date > ${appleNsThreshold} ` +
    `AND m.text IS NOT NULL ` +
    `ORDER BY m.date ASC;`;

  return new Promise<InboundMsg[]>((resolve) => {
    try {
      // -readonly plus a mode=ro URI: chat.db is never opened for writing
      // -separator '|': use | to separate columns since text may contain commas
      execFile(
        'sqlite3',
        ['-readonly', '-separator', '|', readOnlyUri(dbPath), sql],
        { timeout: 5_000 },
        (err, stdout, stderr) => {
          if (err) {
            // Check for permission denial (EPERM / "unable to open" / "authorization denied")
            const errMsg = (stderr ?? '') + (err.message ?? '');
            const isPermErr =
              errMsg.includes('unable to open') ||
              errMsg.includes('authorization denied') ||
              errMsg.includes('EPERM') ||
              errMsg.includes('Operation not permitted');
            if (isPermErr && !_hintEmitted) {
              _hintEmitted = true;
              process.stderr.write(
                '[ashlr comms] Cannot read chat.db — grant Full Disk Access to Terminal ' +
                '(System Settings → Privacy & Security → Full Disk Access).\n',
              );
            }
            return resolve([]);
          }

          const msgs: InboundMsg[] = [];
          for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // Format: text|appleNs  (text may contain | so split from right)
            const lastPipe = trimmed.lastIndexOf('|');
            if (lastPipe < 0) continue;
            // MED-2: strip embedded newlines from the text field so a crafted
            // message body containing \n cannot inject a spurious extra record.
            const text = trimmed.slice(0, lastPipe).replace(/[\r\n]/g, ' ');
            const dateRaw = trimmed.slice(lastPipe + 1);
            const appleNs = parseFloat(dateRaw);
            if (!isFinite(appleNs)) continue;
            const ts = appleNsToUnixMs(appleNs);
            if (ts <= sinceMs) continue; // guard against floating-point drift
            msgs.push({ text, ts, handle });
          }
          resolve(msgs);
        },
      );
    } catch {
      resolve([]);
    }
  });
}

// ---------------------------------------------------------------------------
// Intake read: allowlist + ROWID cursor
// ---------------------------------------------------------------------------

export const chatDbPath = (): string => join(homedir(), 'Library', 'Messages', 'chat.db');
const INTAKE_BATCH_LIMIT = 200;
const SQLITE_TIMEOUT_MS = 5_000;

/** `file:` URI that makes sqlite3 refuse writes (`mode=ro`); path chars that are URI syntax are escaped. */
export function readOnlyUri(dbPath: string): string {
  return `file:${encodeURI(dbPath).replace(/\?/g, '%3F').replace(/#/g, '%23')}?mode=ro`;
}

/**
 * Inbound allowlist: cfg.comms.imessageAllow, else [cfg.comms.imessageHandle].
 * Values come from local config only; empty/non-string entries are dropped and
 * an unconfigured install yields [] (every sender refused).
 */
export function imessageAllowlist(cfg: AshlrConfig): string[] {
  const clean = (v: unknown): string[] =>
    (Array.isArray(v) ? v : []).filter((h): h is string => typeof h === 'string' && h.trim().length > 0).map((h) => h.trim());
  const allow = clean(cfg.comms?.imessageAllow);
  if (allow.length > 0) return [...new Set(allow)];
  return clean([cfg.comms?.imessageHandle]);
}

export interface IntakeMsg {
  rowid: number;
  text: string;
  ts: number;   // unix ms
  handle: string;
}

export type ChatDbState = 'ok' | 'blocked_full_disk_access' | 'missing';
export type IntakePoll =
  | { ok: true; messages: IntakeMsg[] }
  | { ok: false; state: 'disabled' | 'unsupported' | Exclude<ChatDbState, 'ok'> | 'error' };

function isPermissionText(text: string): boolean {
  return /unable to open|authorization denied|EPERM|EACCES|Operation not permitted/i.test(text);
}

function sqlite(args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; permission: boolean }> {
  return new Promise((resolve) => {
    try {
      execFile('sqlite3', args, { timeout: SQLITE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, permission: isPermissionText(`${stderr ?? ''}${err.message ?? ''}`) });
        resolve({ ok: true, stdout });
      });
    } catch {
      resolve({ ok: false, permission: false });
    }
  });
}

/** Highest message.ROWID, or null when unreadable. Used to baseline a first run. */
export async function readMaxRowId(): Promise<{ ok: true; rowid: number } | { ok: false; state: Exclude<ChatDbState, 'ok'> | 'error' }> {
  const out = await sqlite(['-readonly', readOnlyUri(chatDbPath()), 'SELECT COALESCE(MAX(ROWID), 0) FROM message;']);
  if (!out.ok) return { ok: false, state: out.permission ? 'blocked_full_disk_access' : 'error' };
  const rowid = Number(out.stdout.trim());
  return Number.isSafeInteger(rowid) && rowid >= 0 ? { ok: true, rowid } : { ok: false, state: 'error' };
}

/**
 * Read inbound messages with ROWID > afterRowId from allowlisted handles only
 * (is_from_me=0, not tapbacks), oldest first, at most one batch. The allowlist is
 * applied in SQL and again on the parsed rows. Never throws. `-json` output keeps
 * newlines and pipes inside message text from forging extra records.
 */
export async function pollInboundSince(afterRowId: number, cfg: AshlrConfig): Promise<IntakePoll> {
  if (!commsEnabled(cfg)) return { ok: false, state: 'disabled' };
  if (process.platform !== 'darwin') return { ok: false, state: 'unsupported' };
  const allow = imessageAllowlist(cfg).map((h) => h.toLowerCase());
  if (allow.length === 0 || !Number.isSafeInteger(afterRowId) || afterRowId < 0) return { ok: false, state: 'disabled' };
  const probe = probeChatDb();
  if (probe !== 'ok') return { ok: false, state: probe };

  const list = allow.map((h) => `'${h.replace(/'/g, "''")}'`).join(',');
  const sql =
    `SELECT m.ROWID AS rowid, m.date AS date, h.id AS handle, m.text AS text FROM message m ` +
    `JOIN handle h ON m.handle_id = h.ROWID ` +
    `WHERE m.is_from_me = 0 AND m.associated_message_type = 0 ` +
    `AND m.ROWID > ${afterRowId} AND m.text IS NOT NULL AND lower(h.id) IN (${list}) ` +
    `ORDER BY m.ROWID ASC LIMIT ${INTAKE_BATCH_LIMIT};`;
  const out = await sqlite(['-readonly', '-json', readOnlyUri(chatDbPath()), sql]);
  if (!out.ok) return { ok: false, state: out.permission ? 'blocked_full_disk_access' : 'error' };

  let rows: unknown;
  try { rows = out.stdout.trim() ? JSON.parse(out.stdout) : []; } catch { return { ok: false, state: 'error' }; }
  if (!Array.isArray(rows)) return { ok: false, state: 'error' };
  const messages: IntakeMsg[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const { rowid, date, handle, text } = row ?? {};
    if (typeof rowid !== 'number' || !Number.isSafeInteger(rowid) || rowid <= afterRowId) continue;
    if (typeof handle !== 'string' || !allow.includes(handle.toLowerCase())) continue;
    if (typeof text !== 'string' || typeof date !== 'number' || !isFinite(date)) continue;
    messages.push({ rowid, text, ts: appleNsToUnixMs(date), handle });
  }
  return { ok: true, messages };
}

// ---------------------------------------------------------------------------
// Cursor + last-send state (0600 files under <runs>/imessage)
// ---------------------------------------------------------------------------

export function imessageStateDir(runsDir?: string): string {
  return join(runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs'), 'imessage');
}

function writePrivateJson(file: string, value: unknown): void {
  const dir = join(file, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Persisted ROWID cursor, or null when absent or invalid (caller re-baselines). */
export function readCursor(runsDir?: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(imessageStateDir(runsDir), 'cursor.json'), 'utf8')) as { rowid?: unknown };
    return typeof parsed.rowid === 'number' && Number.isSafeInteger(parsed.rowid) && parsed.rowid >= 0 ? parsed.rowid : null;
  } catch {
    return null;
  }
}

/** Atomically persist the cursor (mode 0600). Throws on I/O failure so callers never assume it advanced. */
export function writeCursor(rowid: number, runsDir?: string, now: () => Date = () => new Date()): void {
  if (!Number.isSafeInteger(rowid) || rowid < 0) throw new RangeError('invalid cursor');
  writePrivateJson(join(imessageStateDir(runsDir), 'cursor.json'), { version: 1, rowid, updatedAt: now().toISOString() });
}

/** AppleScript "not authorized to send Apple events" (Automation permission) is -1743. */
function sendErrorCode(text: string): string | null {
  const m = /-(\d{3,5})\b/.exec(text);
  return m ? `-${m[1]}` : null;
}

/** Best effort: remember only whether the last send worked and its numeric error code, never text. */
function recordLastSend(errorCode: string | null): void {
  try {
    writePrivateJson(join(imessageStateDir(), 'last-send.json'),
      { version: 1, at: new Date().toISOString(), ok: errorCode === null, ...(errorCode ? { errorCode } : {}) });
  } catch { /* diagnostics only */ }
}

export function readLastSend(runsDir?: string): { ok: boolean; errorCode?: string; at?: string } | null {
  try {
    const p = JSON.parse(readFileSync(join(imessageStateDir(runsDir), 'last-send.json'), 'utf8')) as Record<string, unknown>;
    if (typeof p['ok'] !== 'boolean') return null;
    return { ok: p['ok'], ...(typeof p['errorCode'] === 'string' ? { errorCode: p['errorCode'] } : {}),
      ...(typeof p['at'] === 'string' ? { at: p['at'] } : {}) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Doctor: read-only readiness evidence
// ---------------------------------------------------------------------------

/**
 * Can this process read chat.db? Opens the file for reading only (no query).
 * macOS answers EPERM/EACCES until Full Disk Access is granted to the
 * responsible app, ENOENT when Messages has never run for this user.
 */
export function probeChatDb(dbPath: string = chatDbPath()): ChatDbState {
  try {
    closeSync(openSync(dbPath, 'r'));
    return 'ok';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES' ? 'blocked_full_disk_access' : 'missing';
  }
}

export interface DoctorCheck {
  id: 'config_handle' | 'chat_db_readable' | 'responsible_binary' | 'sqlite3_present' | 'automation_messages';
  state: string;
  detail: string;
  fixHint: string;
}

export interface DoctorDeps {
  cfg?: AshlrConfig | null;
  probe?: () => ChatDbState;
  sqliteVersion?: () => Promise<string | null>;
  /** Names of the nearest enclosing .app (or parent command) up the process tree. */
  parentApp?: () => Promise<string>;
  lastSend?: () => ReturnType<typeof readLastSend>;
  execPath?: string;
}

const FDA_PATH = 'System Settings > Privacy & Security > Full Disk Access';
const AUTOMATION_PATH = 'System Settings > Privacy & Security > Automation';

function ps(pid: number): Promise<{ ppid: number; comm: string } | null> {
  return new Promise((resolve) => {
    try {
      execFile('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { timeout: 2_000 }, (err, stdout) => {
        const m = err ? null : /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout);
        resolve(m ? { ppid: Number(m[1]), comm: m[2]! } : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Nearest `Something.app` among this process's ancestors, else the parent command name. */
export async function responsibleAppName(): Promise<string> {
  let pid = process.ppid;
  let first = '';
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const row = await ps(pid);
    if (!row) break;
    if (!first) first = basename(row.comm);
    const app = /([^/]+)\.app\//.exec(row.comm);
    if (app) return app[1]!;
    pid = row.ppid;
  }
  return first || 'unknown';
}

function sqliteVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('sqlite3', ['-version'], { timeout: 2_000 }, (err, stdout) => resolve(err ? null : stdout.trim().split(/\s+/)[0] || 'present'));
    } catch {
      resolve(null);
    }
  });
}

/** Local evidence only: reads files and spawns `sqlite3 -version` and `ps`. Never sends, never prints handles. */
export async function buildDoctorReport(deps: DoctorDeps = {}): Promise<{ schemaVersion: 1; readOnly: true; ok: boolean; checks: DoctorCheck[] }> {
  const cfg = deps.cfg ?? null;
  const parent = await (deps.parentApp ?? responsibleAppName)();
  const app = parent === 'unknown' ? 'the app running this command (Terminal, iTerm or the desktop app)' : parent;
  const checks: DoctorCheck[] = [];

  const allow = cfg ? imessageAllowlist(cfg) : [];
  checks.push({
    id: 'config_handle',
    state: !cfg ? 'unavailable' : allow.length > 0 ? 'set' : 'not_set',
    detail: !cfg ? 'config unreadable' : allow.length > 0 ? `${allow.length} allowlisted handle(s), comms ${cfg.comms?.enabled === true ? 'enabled' : 'disabled'}` : 'no handle configured',
    fixHint: 'Set comms.imessageHandle (optionally comms.imessageAllow) and comms.enabled in ~/.ashlr/config.json. Values stay local.',
  });

  const db = process.platform === 'darwin' ? (deps.probe ?? probeChatDb)() : 'missing';
  checks.push({
    id: 'chat_db_readable',
    state: db,
    detail: db === 'ok' ? 'chat.db opens read-only' : db === 'missing' ? 'chat.db not found (or not macOS)' : 'macOS denied read access to chat.db',
    fixHint: `Open ${FDA_PATH}, enable ${app}, then restart it. Messages must have been used once on this Mac.`,
  });

  checks.push({
    id: 'responsible_binary',
    state: 'info',
    detail: `execPath=${deps.execPath ?? process.execPath} parentApp=${parent}`,
    fixHint: `Full Disk Access and Automation apply to the app that launched this process (${app}); grant them in ${FDA_PATH} and ${AUTOMATION_PATH}.`,
  });

  const version = await (deps.sqliteVersion ?? sqliteVersion)();
  checks.push({
    id: 'sqlite3_present',
    state: version ? 'ok' : 'missing',
    detail: version ? `sqlite3 ${version}` : 'sqlite3 not found on PATH',
    fixHint: 'sqlite3 ships with macOS; if missing, install the Command Line Tools (xcode-select --install) or Homebrew sqlite.',
  });

  const last = (deps.lastSend ?? readLastSend)();
  const blocked = last?.errorCode === '-1743';
  checks.push({
    id: 'automation_messages',
    state: !last ? 'unknown' : last.ok ? 'ok' : blocked ? 'blocked' : 'error',
    detail: !last ? 'no send attempted yet; permission is requested on first send' : last.ok ? 'last send succeeded'
      : blocked ? 'last send failed with -1743 (not authorized to control Messages)' : `last send failed${last.errorCode ? ` (${last.errorCode})` : ''}`,
    fixHint: `Open ${AUTOMATION_PATH}, enable Messages under ${app}. Intake does not need it; replies do.`,
  });

  const ok = checks.every((c) => !['not_set', 'missing', 'blocked', 'blocked_full_disk_access', 'unavailable', 'error'].includes(c.state));
  return { schemaVersion: 1, readOnly: true, ok, checks };
}
