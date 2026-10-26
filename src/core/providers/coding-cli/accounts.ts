/**
 * Several logins per coding CLI. Each account has its own credential home,
 * quota reading, reset and health. Codex spends the primary work account
 * first. A dead primary is not selected again.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { isSecretEnvName, scrubAdapterEnv } from './env.js';
import type { AccountRecord, CodingCliCatalog } from './catalog.js';

const DEFAULT_CODEX_DIR: Readonly<Record<string, string>> = {
  CODEX_HOME: '.codex',
  CODEX_HOME_ALT: '.codex-2',
};

export interface CodingAccount {
  id: string;
  backend: string;
  home: string | null;
  health: 'ready' | 'unavailable' | 'unknown' | 'dead';
  usedPercent: number | null;
  resetsAt: string | null;
  cooledUntilMs: number | null;
}

export interface AccountReading {
  usedPercent: number | null;
  resetsAt: string | null;
  health?: CodingAccount['health'];
  cooledUntilMs?: number | null;
}

function homeFromEnv(record: AccountRecord, env: NodeJS.ProcessEnv): { home: string | null; blocked: boolean } {
  if (!record.homeEnv) return { home: null, blocked: false };
  if (isSecretEnvName(record.homeEnv)) return { home: null, blocked: true };
  const value = env[record.homeEnv];
  if (typeof value === 'string' && value.trim() !== '') return { home: value.trim(), blocked: false };
  const fallback = DEFAULT_CODEX_DIR[record.homeEnv];
  if (fallback) return { home: join(homedir(), fallback), blocked: false };
  return { home: null, blocked: record.requiresHome };
}

/** One row per catalog account. An empty catalog list becomes one default account per backend. */
export function resolveAccounts(
  catalog: CodingCliCatalog,
  env: NodeJS.ProcessEnv,
  readings: Readonly<Record<string, AccountReading>> = {},
): CodingAccount[] {
  const listed = new Set(catalog.accounts.map((account) => account.backend));
  const defaults: AccountRecord[] = Object.entries(catalog.backends)
    .filter(([backend, record]) => !listed.has(backend) && record.enabledByDefault)
    .map(([backend]) => ({ id: backend, backend, homeEnv: null, requiresHome: false }));
  const records = [...catalog.accounts, ...defaults];
  return records.map((record) => {
    const home = homeFromEnv(record, env);
    const reading = readings[record.id];
    const health: CodingAccount['health'] = home.blocked ? 'unavailable' : (reading?.health ?? 'unknown');
    return {
      id: record.id,
      backend: record.backend,
      home: home.home,
      health,
      usedPercent: reading?.usedPercent ?? null,
      resetsAt: reading?.resetsAt ?? null,
      cooledUntilMs: reading?.cooledUntilMs ?? null,
    };
  });
}

/**
 * Codex primary wins while it is alive, even when another account has more
 * headroom. Other backends still prefer the lower used percent.
 */
export function bestAccount(
  accounts: readonly CodingAccount[],
  backend: string,
  nowMs: number,
  dead: readonly string[] = [],
): CodingAccount | null {
  const open = accounts.filter((account) => {
    if (account.backend !== backend || account.health === 'unavailable' || account.health === 'dead') return false;
    if (dead.includes(account.id)) return false;
    return account.cooledUntilMs === null || account.cooledUntilMs <= nowMs;
  });
  if (backend === 'codex') {
    const primary = open.find((account) => account.id === 'codex-primary');
    if (primary) return primary;
  }
  return [...open].sort((a, b) => {
    const usedA = a.usedPercent === null ? 101 : a.usedPercent;
    const usedB = b.usedPercent === null ? 101 : b.usedPercent;
    if (usedA !== usedB) return usedA - usedB;
    const resetA = a.resetsAt ? Date.parse(a.resetsAt) : Number.MAX_SAFE_INTEGER;
    const resetB = b.resetsAt ? Date.parse(b.resetsAt) : Number.MAX_SAFE_INTEGER;
    if (resetA !== resetB) return resetA - resetB;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0] ?? null;
}

export function failoverAccount(
  accounts: readonly CodingAccount[],
  backend: string,
  failedId: string,
  nowMs: number,
  dead: readonly string[] = [],
): CodingAccount | null {
  const skip = dead.includes(failedId) ? dead : [...dead, failedId];
  return bestAccount(accounts, backend, nowMs, skip);
}

/** Scrubbed env plus this account's credential home. API keys are not copied. */
export function accountEnv(source: NodeJS.ProcessEnv, account: CodingAccount | null): NodeJS.ProcessEnv {
  const env = scrubAdapterEnv(source);
  if (!account?.home) return env;
  if (account.backend === 'codex') env['CODEX_HOME'] = account.home;
  if (account.backend === 'claude') env['CLAUDE_CONFIG_DIR'] = account.home;
  return env;
}
