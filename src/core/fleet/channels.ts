/**
 * `phm channels` — the six inbound channel kinds: what is configured, where the
 * credential lives, and how much each has carried.
 *
 * `add` writes configuration only. It never accepts, stores, or prints a
 * credential: tokens and pairing secrets stay in their existing custody
 * (environment variables or private `0600` files). `status` is read-only and
 * reports real counts; a source that cannot be read reports 'unknown', never a
 * fabricated zero.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { loadConfig, saveConfig } from '../config.js';
import {
  normalizeEmailDropAddress,
  readEmailDropConfig,
  writeEmailDropConfig,
  type EmailDropConfig,
} from '../comms/email-drop-config.js';
import { readPrivateFileCapped } from '../verse/preferences.js';
import { INBOUND_CHANNELS, type InboundChannel } from './channel-envelope.js';
import { readInboxEntries } from './mason-inbox.js';

export type ChannelCredential = 'environment' | 'config' | 'file' | 'none-needed' | 'missing';
/** A measured count; 'unknown' when its source could not be read. */
export type CountOrUnknown = number | 'unknown';

export interface ChannelStatusRow {
  kind: InboundChannel;
  /** Config side is complete enough for the channel to carry a message. */
  configured: boolean;
  /** Where the channel's credential lives — never the value. */
  credential: ChannelCredential;
  /** Verified-sender pairing state; 'unknown' when the pairing store cannot be read; null when the channel has no pairing step. */
  paired: boolean | 'unknown' | null;
  /** Inbox entries attributed to the channel (bounded tail — same read as `phm comms inbox read`). */
  received: CountOrUnknown;
  /** `at` string of the newest attributed entry; null when none; 'unknown' when unreadable. */
  lastSeenAt: string | null | 'unknown';
  /** Messages queued for the channel's outbound path. */
  pendingOutbound: CountOrUnknown;
  /** True when nothing stands between the channel and its next message. */
  ready: boolean;
  /** Plain-language next step when the channel is not ready. */
  next?: string;
}

export interface ChannelsStatus {
  v: 1;
  at: string;
  /** Health of the shared inbox read every row's counts come from. */
  inbox: 'healthy' | 'missing' | 'degraded';
  channels: ChannelStatusRow[];
}

export interface ChannelsStatusOptions {
  cfg?: AshlrConfig;
  /** Defaults to ~/.ashlr-runs (honors a relocated HOME). */
  runsDir?: string;
  /** Defaults to homedir(). */
  homeDir?: string;
  /** Defaults to process.env — presence checks only, values are never read. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** A shared-inbox read the caller already made, so one pass reads the file once. */
  inbox?: Awaited<ReturnType<typeof readInboxEntries>>;
}

/** Map an inbox `source` label back to its channel kind. */
export function channelKindForSource(source: string): InboundChannel | 'other' {
  const value = source.trim().toLowerCase();
  if ((INBOUND_CHANNELS as readonly string[]).includes(value)) return value as InboundChannel;
  if (value.includes('telegram')) return 'telegram';
  if (value.includes('mail')) return 'email';
  if (value.includes('mobile') || value.includes('remote') || value.includes('phone')) return 'mobile';
  if (value.includes('page') || value.includes('7790')) return 'page';
  if (value.includes('cli') || value.includes('terminal')) return 'cli';
  if (value.includes('desktop') || value.includes('composer')) return 'desktop';
  return 'other';
}

function telegramCredential(cfg: AshlrConfig, env: NodeJS.ProcessEnv): ChannelCredential {
  if (typeof env['TELEGRAM_BOT_TOKEN'] === 'string' && env['TELEGRAM_BOT_TOKEN'].trim() !== '') return 'environment';
  if (typeof cfg.comms?.telegram?.botToken === 'string' && cfg.comms.telegram.botToken.trim() !== '') return 'config';
  return 'missing';
}

function emailCredential(homeDir: string, env: NodeJS.ProcessEnv): ChannelCredential {
  if (typeof env['PHANTOM_OPERATOR_SECRET'] === 'string' && env['PHANTOM_OPERATOR_SECRET'].trim() !== '') return 'environment';
  try {
    if (existsSync(join(homeDir, '.ashlr', 'comms', 'operator-secret'))) return 'file';
  } catch { /* unreadable stays 'missing' */ }
  return 'missing';
}

/**
 * Telegram pairing record: absent file is verified-unpaired; a present record
 * proves pairing only with a positive integer userId — anything else unreadable
 * or malformed is 'unknown', never a guessed "not paired".
 */
function telegramPaired(runsDir: string): boolean | 'unknown' {
  const path = join(runsDir, 'queue', 'telegram-pair.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : 'unknown';
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
    const userId = (parsed as { userId?: unknown }).userId;
    return Number.isSafeInteger(userId) && (userId as number) > 0 ? true : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Verified email senders: addresses that completed the pairing-secret handshake.
 * A missing file is a measured zero; an unreadable or malformed one is 'unknown'.
 */
export function emailPairedCount(runsDir: string): CountOrUnknown {
  const path = join(runsDir, 'queue', 'email-paired.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : 'unknown';
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
    const addresses = (parsed as { addresses?: unknown }).addresses;
    if (!Array.isArray(addresses)) return 'unknown';
    return addresses.filter((a): a is string => typeof a === 'string').length;
  } catch {
    return 'unknown';
  }
}

/** Leader-thread outbound index: 'pending' telegram deliveries. Read-only — no memo sync. */
function telegramPendingOutbound(homeDir: string): CountOrUnknown {
  const indexPath = join(homeDir, '.ashlr', 'vision', 'leader', 'thread-index.json');
  try {
    // statSync, not existsSync: a permission failure must not read as "no file".
    if (!statSync(indexPath).isFile()) return 'unknown';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : 'unknown';
  }
  try {
    const read = readPrivateFileCapped(indexPath, 512 * 1024);
    if (!read || read.truncated) return 'unknown';
    const parsed: unknown = JSON.parse(read.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
    const delivery = (parsed as { delivery?: unknown }).delivery;
    if (delivery === null || delivery === undefined) return 0;
    if (typeof delivery !== 'object' || Array.isArray(delivery)) return 'unknown';
    let pending = 0;
    for (const state of Object.values(delivery as Record<string, unknown>)) {
      if (state && typeof state === 'object' && (state as { telegram?: unknown }).telegram === 'pending') pending++;
    }
    return pending;
  } catch {
    return 'unknown';
  }
}

/** Reply `.eml` files waiting in the configured email outbox. */
function emailPendingOutbound(config: EmailDropConfig | undefined): CountOrUnknown {
  if (!config?.outboxDir) return 'unknown';
  try {
    return readdirSync(config.outboxDir).filter((name) => name.endsWith('.eml')).length;
  } catch (error) {
    // A missing outbox holds no replies; any other read failure is unknown.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : 'unknown';
  }
}

const BUILT_IN: ReadonlySet<InboundChannel> = new Set(['cli', 'desktop', 'page']);

export async function buildChannelsStatus(opts: ChannelsStatusOptions = {}): Promise<ChannelsStatus> {
  const cfg = opts.cfg ?? loadConfig();
  const homeDir = opts.homeDir ?? homedir();
  const runsDir = opts.runsDir ?? join(homeDir, '.ashlr-runs');
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());

  const inbox = opts.inbox ?? await readInboxEntries({ runsDir, limit: Number.MAX_SAFE_INTEGER });
  const seen = new Map<InboundChannel, { received: number; lastSeenAt: string | null; lastMs: number }>();
  if (inbox.sourceState !== 'degraded') {
    for (const entry of inbox.entries) {
      const kind = channelKindForSource(entry.source);
      if (kind === 'other') continue;
      const ms = Date.parse(entry.at);
      const row = seen.get(kind) ?? { received: 0, lastSeenAt: null, lastMs: Number.NEGATIVE_INFINITY };
      row.received++;
      if (Number.isFinite(ms) && ms >= row.lastMs) { row.lastMs = ms; row.lastSeenAt = entry.at; }
      else if (row.lastSeenAt === null && !Number.isFinite(ms)) { row.lastSeenAt = entry.at; }
      seen.set(kind, row);
    }
  }

  const degraded = inbox.sourceState === 'degraded';
  const receivedOf = (kind: InboundChannel): CountOrUnknown =>
    degraded ? 'unknown' : seen.get(kind)?.received ?? 0;
  const lastSeenOf = (kind: InboundChannel): string | null | 'unknown' =>
    degraded ? 'unknown' : seen.get(kind)?.lastSeenAt ?? null;

  const telegramChatId = cfg.comms?.telegram?.chatId;
  const telegramConfigured = cfg.comms?.channel === 'telegram' && cfg.comms?.enabled === true &&
    typeof telegramChatId === 'string' && /^[1-9]\d*$/.test(telegramChatId);
  const telegramCred = telegramCredential(cfg, env);

  const emailConfig = await readEmailDropConfig(runsDir);
  const emailConfigured = emailConfig.state === 'ok';
  const emailCred = emailCredential(homeDir, env);
  const emailPairs = emailPairedCount(runsDir);

  const mobileConfigured = existsSync(join(homeDir, '.ashlr', 'verse-remote.json'));

  const rows: ChannelStatusRow[] = [
    {
      kind: 'telegram',
      configured: telegramConfigured,
      credential: telegramCred,
      paired: telegramPaired(runsDir),
      received: receivedOf('telegram'),
      lastSeenAt: lastSeenOf('telegram'),
      pendingOutbound: telegramPendingOutbound(homeDir),
      ready: telegramConfigured && telegramCred !== 'missing',
      ...(telegramConfigured && telegramCred !== 'missing' ? {} : {
        next: telegramConfigured
          ? 'put the bot token in TELEGRAM_BOT_TOKEN (or comms.telegram.botToken) — never on the command line'
          : 'phm channels add telegram <chat-id> — the token stays in TELEGRAM_BOT_TOKEN',
      }),
    },
    {
      kind: 'email',
      configured: emailConfigured,
      credential: emailCred,
      paired: emailPairs === 'unknown' ? 'unknown' : emailPairs > 0,
      received: receivedOf('email'),
      lastSeenAt: lastSeenOf('email'),
      pendingOutbound: emailPendingOutbound(emailConfig.config),
      ready: emailConfigured,
      ...(emailConfigured ? {} : {
        next: emailConfig.state === 'invalid'
          ? `email-drop config is invalid at ${emailConfig.path}`
          : 'phm channels add email <inboxDir> --from <address>',
      }),
    },
    {
      kind: 'mobile',
      configured: mobileConfigured,
      credential: 'none-needed',
      paired: null,
      received: receivedOf('mobile'),
      lastSeenAt: lastSeenOf('mobile'),
      pendingOutbound: 0,
      ready: mobileConfigured,
      ...(mobileConfigured ? {} : { next: 'the phone gateway needs ~/.ashlr/verse-remote.json — see docs/REMOTE-PHONE.md' }),
    },
    ...INBOUND_CHANNELS.filter((kind) => BUILT_IN.has(kind)).map((kind) => ({
      kind,
      configured: true,
      credential: 'none-needed' as ChannelCredential,
      paired: null,
      received: receivedOf(kind),
      lastSeenAt: lastSeenOf(kind),
      pendingOutbound: 0,
      ready: true,
    })),
  ];

  // Keep the documented INBOUND_CHANNELS order.
  rows.sort((a, b) => INBOUND_CHANNELS.indexOf(a.kind) - INBOUND_CHANNELS.indexOf(b.kind));
  return { v: 1, at: now().toISOString(), inbox: inbox.sourceState, channels: rows };
}

// ---------------------------------------------------------------------------
// add — configuration only; no transport, pairing, polling, or credential IO.
// ---------------------------------------------------------------------------

export interface ChannelAddInput {
  /** telegram: the private numeric chat id (`comms.telegram.chatId`). */
  chatId?: string;
  /** email: drop-folder inbox directory. */
  inboxDir?: string;
  /** email: verified sender allowlist (required, 1..32). */
  from?: string[];
  outboxDir?: string;
  processedDir?: string;
  cfg?: AshlrConfig;
  runsDir?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ChannelAddResult {
  ok: boolean;
  kind: InboundChannel;
  /** Config keys written, or files written — never values. */
  changed: string[];
  credential: ChannelCredential;
  /** Absolute path written, when one file carries the whole channel config. */
  path?: string;
  /** Plain-language next step for the operator. */
  next?: string;
  reason?: string;
}

const TELEGRAM_CHAT_ID_RE = /^[1-9]\d*$/;

export async function addChannel(kind: InboundChannel, input: ChannelAddInput = {}): Promise<ChannelAddResult> {
  const env = input.env ?? process.env;
  const runsDir = input.runsDir ?? join(input.homeDir ?? homedir(), '.ashlr-runs');

  if (kind === 'telegram') {
    const chatId = input.chatId?.trim();
    if (!chatId || !TELEGRAM_CHAT_ID_RE.test(chatId)) {
      return {
        ok: false, kind, changed: [], credential: 'missing',
        reason: 'telegram needs the private numeric chat id: phm channels add telegram <chat-id> (run `phm comms setup-telegram` to discover it)',
      };
    }
    const cfg = input.cfg ?? loadConfig();
    const comms = (cfg.comms ??= {});
    const telegram = (comms.telegram ??= {});
    const changed: string[] = [];
    if (comms.enabled !== true) { comms.enabled = true; changed.push('comms.enabled'); }
    if (comms.channel !== 'telegram') { comms.channel = 'telegram'; changed.push('comms.channel'); }
    if (telegram.chatId !== chatId) { telegram.chatId = chatId; changed.push('comms.telegram.chatId'); }
    saveConfig(cfg);
    const credential = telegramCredential(cfg, env);
    return {
      ok: true, kind, changed, credential,
      next: credential === 'missing'
        ? 'put the bot token in TELEGRAM_BOT_TOKEN or comms.telegram.botToken — never on the command line; the first inbound message pairs the sender'
        : 'the first inbound message from that chat pairs the sender id',
    };
  }

  if (kind === 'email') {
    const inboxDir = input.inboxDir?.trim();
    if (!inboxDir || !isAbsolute(inboxDir)) {
      return {
        ok: false, kind, changed: [], credential: 'missing',
        reason: 'email needs an absolute drop-folder path: phm channels add email <inboxDir> --from <address>',
      };
    }
    const from: string[] = [];
    for (const raw of input.from ?? []) {
      const address = normalizeEmailDropAddress(raw);
      if (address === null) {
        return {
          ok: false, kind, changed: [], credential: 'missing',
          reason: `invalid --from address: ${raw}`,
        };
      }
      if (!from.includes(address)) from.push(address);
    }
    if (from.length < 1 || from.length > 32) {
      return {
        ok: false, kind, changed: [], credential: 'missing',
        reason: 'email needs 1..32 allowlisted From addresses: --from <address> (unlisted senders are refused)',
      };
    }
    const path = await writeEmailDropConfig(runsDir, {
      v: 1,
      inboxDir: resolve(inboxDir),
      outboxDir: input.outboxDir ? resolve(input.outboxDir) : undefined,
      processedDir: input.processedDir ? resolve(input.processedDir) : undefined,
      from,
    });
    const credential = emailCredential(input.homeDir ?? homedir(), env);
    return {
      ok: true, kind, changed: ['queue/email-drop.json'], path, credential,
      next: credential === 'missing'
        ? '`phm comms cycle` runs the drop each pass — senders stay allowlist-only until PHANTOM_OPERATOR_SECRET is set'
        : '`phm comms cycle` runs the drop each pass — the first mail carries the pairing secret on its own line',
    };
  }

  if (kind === 'mobile') {
    const configured = existsSync(join(input.homeDir ?? homedir(), '.ashlr', 'verse-remote.json'));
    return {
      ok: true, kind, changed: [], credential: 'none-needed',
      next: configured
        ? 'the phone gateway is already configured — open /verse/m'
        : 'the phone gateway needs a private ~/.ashlr/verse-remote.json — see docs/REMOTE-PHONE.md',
    };
  }

  // cli / desktop / page are built in: posting, the composer, and the page need no config.
  return {
    ok: true, kind, changed: [], credential: 'none-needed',
    next: kind === 'cli'
      ? 'no setup — `phm comms inbox post --file <file|->` posts to the shared inbox'
      : `no setup — the ${kind} channel is built in`,
  };
}
