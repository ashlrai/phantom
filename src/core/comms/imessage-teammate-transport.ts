/** Team-only native transport. Owner-only sendIMessage remains unchanged. */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { imessageAllowlist, isSelfIMessageHandle } from '../integrations/imessage.js';
import { checkSendPolicy, parseCommsConfirmation, parseTeamIdentities } from '../agents/channel-policy.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { isPaused } from './pause.js';
import { senderIdFor } from './imessage-teammate-inbox.js';

export interface TeamMessageReceipt { rowid: number; sent: boolean; delivered: boolean; error: number }
export interface TeamTransportOptions { configDir?: string }

function readConfig(name: string, options: TeamTransportOptions): string {
  const dir = options.configDir ?? join(homedir(), '.ashlr');
  const result = readStableRegularFile(join(dir, name), { anchorPath: dir, maxFileBytes: 65536, remainingBytes: 65536 });
  return result.ok ? result.text : '';
}

/** Raw handles are resolved only from local configuration, never a message body. */
export function approvedTeammateHandle(senderId: string, cfg: AshlrConfig, options: TeamTransportOptions = {}): string | null {
  if (cfg.comms?.enabled !== true || isPaused()) return null;
  const handle = imessageAllowlist(cfg).find(value => senderIdFor(value) === senderId && !isSelfIMessageHandle(value, cfg));
  if (!handle) return null;
  const decision = checkSendPolicy({ channel: 'imessage', recipients: [senderId], external: false,
    teamIdentities: parseTeamIdentities(readConfig('agent-network.toml', options)),
    confirmedByMason: parseCommsConfirmation(readConfig('comms.toml', options)) });
  return decision.status === 'sent' ? handle : null;
}

function run(file: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise(resolve => {
    try { execFile(file, args, { timeout, maxBuffer: 65536 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) })); }
    catch { resolve({ ok: false, stdout: '' }); }
  });
}

/** Re-check authority immediately before sending. A transport return is not delivery proof. */
export async function sendApprovedTeammateMessage(text: string, senderId: string, cfg: AshlrConfig, options: TeamTransportOptions = {}): Promise<'accepted' | 'uncertain' | 'refused'> {
  const handle = approvedTeammateHandle(senderId, cfg, options);
  if (process.platform !== 'darwin' || !handle || !text.trim() || text.length > 4000) return 'refused';
  const script = 'on run argv\n tell application "Messages"\n send (item 2 of argv) to participant (item 1 of argv) of (1st service whose service type = iMessage)\n end tell\nend run';
  const result = await run('/usr/bin/osascript', ['-e', script, handle, text], 10000);
  return result.ok ? 'accepted' : 'uncertain';
}

/** Exact-text matching also handles modern macOS attributed-body-only outgoing messages. */
export async function reconcileTeammateMessage(text: string, senderId: string, afterMs: number, cfg: AshlrConfig, options: TeamTransportOptions = {}): Promise<TeamMessageReceipt | null> {
  const handle = approvedTeammateHandle(senderId, cfg, options);
  if (process.platform !== 'darwin' || !handle || !Number.isFinite(afterMs) || afterMs < 0) return null;
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const hex = Buffer.from(text).toString('hex').toUpperCase();
  const appleDate = Math.max(0, Math.floor((afterMs - 978307200000) * 1000000));
  const sql = `SELECT m.ROWID AS rowid,m.is_sent AS sent,m.is_delivered AS delivered,m.error AS error FROM message m JOIN handle h ON m.handle_id=h.ROWID WHERE m.is_from_me=1 AND lower(h.id)=lower(${quote(handle)}) AND m.date>=${appleDate} AND (m.text=${quote(text)} OR instr(hex(m.attributedBody),'${hex}')>0) ORDER BY m.ROWID DESC LIMIT 1;`;
  const result = await run('/usr/bin/sqlite3', ['-readonly', '-json', `file:${join(homedir(), 'Library/Messages/chat.db')}?mode=ro`, sql], 5000);
  try {
    const row = (JSON.parse(result.stdout) as Array<Record<string, unknown>>)[0];
    return result.ok && row && Number.isSafeInteger(row.rowid) && Number(row.rowid) > 0
      ? { rowid: Number(row.rowid), sent: row.sent === 1, delivered: row.delivered === 1, error: Number(row.error) } : null;
  } catch { return null; }
}
