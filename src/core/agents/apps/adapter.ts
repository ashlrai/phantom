/**
 * Provider-neutral agent app adapters over the CLI and desktop surfaces of
 * Codex, Claude, Devin, Grok and Cursor. App text is scrubbed, capped, untrusted.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { scrubSecrets } from '../../util/scrub.js';

export const AGENT_APP_CAPABILITIES = ['launchTask', 'listSessions', 'readSession', 'sendMessage', 'readUsage'] as const;
export type AgentAppCapability = (typeof AGENT_APP_CAPABILITIES)[number];
export type AgentAppProvider = 'codex' | 'claude' | 'devin' | 'grok' | 'cursor';

export type AgentAppResult<T> = { ok: true; value: T } | { ok: false; code: string; error: string };

export interface AgentAppSession {
  adapter: string; sessionId: string; status: 'idle' | 'failed' | 'unknown';
  model: string | null; updatedAt: string | null; output: string | null; untrusted: true;
}

export interface AgentAppUsage { adapter: string; text: string | null; untrusted: true }

export interface AgentAppDescriptor {
  id: string; provider: AgentAppProvider; surface: 'cli' | 'desktop';
  /** null when availability needs a live probe (desktop grants). */
  available: boolean | null; reason: string | null;
  capabilities: Record<AgentAppCapability, { supported: boolean; reason: string | null }>;
}

export interface AgentAppAdapter {
  readonly id: string; readonly provider: AgentAppProvider; readonly surface: 'cli' | 'desktop';
  describe(): Promise<AgentAppDescriptor>;
  launchTask(input: { prompt: string; model?: string; cwd?: string }): Promise<AgentAppResult<AgentAppSession>>;
  listSessions(): Promise<AgentAppResult<AgentAppSession[]>>;
  readSession(sessionId: string): Promise<AgentAppResult<AgentAppSession>>;
  sendMessage(sessionId: string, text: string): Promise<AgentAppResult<AgentAppSession>>;
  readUsage(input?: { window?: string }): Promise<AgentAppResult<AgentAppUsage>>;
}

export const MAX_PROMPT_CHARS = 20_000;
export const MAX_OUTPUT_CHARS = 8_000;
const MODEL = /^[A-Za-z0-9._:/-]{1,80}$/;

export const refuse = (code: string, error: string): { ok: false; code: string; error: string } => ({ ok: false, code, error: scrubSecrets(error).slice(0, 300) });

export function cleanOutput(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  return scrubSecrets(text).slice(0, MAX_OUTPUT_CHARS);
}

/** Null when the launch/send input is acceptable. */
export function invalidInput(input: { prompt?: string; model?: string; cwd?: string }): string | null {
  if (input.prompt !== undefined && (input.prompt.trim().length === 0 || input.prompt.length > MAX_PROMPT_CHARS)) return `prompt must be 1 to ${MAX_PROMPT_CHARS} characters`;
  if (input.model !== undefined && !MODEL.test(input.model)) return 'model must be a short model id';
  if (input.cwd !== undefined && (!isAbsolute(input.cwd) || input.cwd.includes('\0'))) return 'cwd must be an absolute path';
  return null;
}

/** A stop probe that throws counts as engaged. */
export const stopEngaged = (probe: () => boolean): boolean => { try { return probe() !== false; } catch { return true; } };

// Local ledger of CLI sessions this surface started, so status/output reads need no provider list API.
export interface AgentAppLedgerRow { adapter: string; sessionId: string; status: AgentAppSession['status']; model: string | null; updatedAt: string; output: string | null }

export function defaultAgentAppLedgerPath(): string {
  const configured = process.env['ASHLR_HOME'];
  const root = configured && isAbsolute(configured) ? configured : join(homedir(), '.ashlr');
  return join(root, 'agent-apps', 'sessions.json');
}

export function readAgentAppLedger(path: string): AgentAppLedgerRow[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: unknown };
    return Array.isArray(parsed.sessions) ? parsed.sessions.filter((row): row is AgentAppLedgerRow =>
      !!row && typeof row === 'object' && typeof (row as AgentAppLedgerRow).adapter === 'string' && typeof (row as AgentAppLedgerRow).sessionId === 'string') : [];
  } catch { return []; }
}

export function upsertAgentAppLedger(path: string, row: AgentAppLedgerRow): void {
  const rows = readAgentAppLedger(path).filter((r) => !(r.adapter === row.adapter && r.sessionId === row.sessionId));
  rows.unshift(row);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ schema: 'ashlr.agent-apps.sessions.v1', sessions: rows.slice(0, 200) }), { mode: 0o600 });
  renameSync(tmp, path);
}

export function sessionFromRow(row: AgentAppLedgerRow): AgentAppSession {
  return { adapter: row.adapter, sessionId: row.sessionId, status: row.status, model: row.model, updatedAt: row.updatedAt, output: cleanOutput(row.output), untrusted: true };
}

export interface AgentAppRegistry { list(): AgentAppAdapter[]; get(id: string): AgentAppAdapter | undefined }

export function createRegistry(adapters: readonly AgentAppAdapter[]): AgentAppRegistry {
  const byId = new Map<string, AgentAppAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) throw new Error(`duplicate agent app adapter ${adapter.id}`);
    byId.set(adapter.id, adapter);
  }
  return { list: () => [...byId.values()], get: (id) => byId.get(id) };
}

export async function describeAgentApps(registry: AgentAppRegistry): Promise<{ schema: 'ashlr.agent-apps.v1'; apps: AgentAppDescriptor[] }> {
  return { schema: 'ashlr.agent-apps.v1', apps: await Promise.all(registry.list().map((adapter) => adapter.describe())) };
}

export function capabilityTable(supported: Partial<Record<AgentAppCapability, string | null>>): AgentAppDescriptor['capabilities'] {
  return Object.fromEntries(AGENT_APP_CAPABILITIES.map((cap) => {
    const reason = supported[cap];
    return [cap, reason === null ? { supported: true, reason: null } : { supported: false, reason: reason ?? 'not supported by this adapter' }];
  })) as AgentAppDescriptor['capabilities'];
}
