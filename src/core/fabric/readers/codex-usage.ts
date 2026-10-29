import { spawn } from 'node:child_process';
import { appendFile, realpath, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface CodexUsageReading {
  pool: 'codex-cmp';
  pctUsed: number | null;
  resetAt: string | null;
  terraResetAt: string | null;
  source: 'codex-reader';
  fetchedAt: string;
}

export interface CodexUsageOptions {
  /** Explicit CMP pool HOME, never the operator's HOME or a copied profile. */
  home?: string;
  /** Append both account aliases to this usage-readings.log. Errors propagate. */
  logPath?: string;
}

const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;
const NATIVE_ARGS = ['app-server', '--stdio', '-c', 'analytics.enabled=false',
  '-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"'];
type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Exact native bucket only. An authoritative map never falls back to legacy.
 * Use the fullest reported window, breaking ties by the later reset. Missing,
 * expired or malformed windows cannot establish current account headroom.
 * https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt
 */
export function parseCodexUsage(payload: unknown, nowMs: number): Pick<CodexUsageReading, 'pctUsed' | 'resetAt' | 'terraResetAt'> {
  try { return parseNativeUsage(payload, nowMs); }
  catch { return { pctUsed: null, resetAt: null, terraResetAt: null }; }
}

function parseNativeUsage(payload: unknown, nowMs: number): Pick<CodexUsageReading, 'pctUsed' | 'resetAt' | 'terraResetAt'> {
  const unknown = { pctUsed: null, resetAt: null, terraResetAt: null };
  if (!object(payload) || !Number.isFinite(nowMs)) return unknown;
  const hasMap = Object.hasOwn(payload, 'rateLimitsByLimitId');
  const bucket = hasMap
    ? object(payload.rateLimitsByLimitId) && Object.hasOwn(payload.rateLimitsByLimitId, 'codex') && payload.rateLimitsByLimitId.codex
    : payload.rateLimits;
  if (!object(bucket) || (hasMap ? bucket.limitId != null && bucket.limitId !== 'codex' : bucket.limitId !== 'codex')) return unknown;
  const windows: { pctUsed: number; resetAt: string }[] = [];
  for (const key of ['primary', 'secondary']) {
    const window = bucket[key];
    if (window === undefined || window === null) continue;
    if (!object(window) || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 || window.usedPercent > 100 || typeof window.resetsAt !== 'number' ||
        !Number.isSafeInteger(window.resetsAt) || window.resetsAt <= nowMs / 1000 ||
        window.resetsAt > 253_402_300_799) return unknown;
    windows.push({ pctUsed: window.usedPercent, resetAt: new Date(window.resetsAt * 1000).toISOString() });
  }
  const selected = windows.sort((a, b) => b.pctUsed - a.pctUsed || Date.parse(b.resetAt) - Date.parse(a.resetAt))[0];
  // A provider denial without a measured full window is not a percentage.
  if (!selected || bucket.rateLimitReachedType != null && selected.pctUsed !== 100) return unknown;
  // Terra uses this CMP account's shared Codex quota, not another account or
  // an inferred model-specific allowance. Both aliases retain identical evidence.
  return { ...selected, terraResetAt: selected.resetAt };
}

async function cmpHome(home: string | undefined): Promise<string | null> {
  if (!home || !isAbsolute(home) || resolve(home) !== home) return null;
  // Do not even inspect the operator's native credential directories. The
  // explicit pool HOME must be separate; symlinked profile copies are refused.
  const operatorHome = userInfo().homedir;
  if (home === operatorHome || home === resolve(home, '..') ||
      home === join(operatorHome, '.codex') || home.startsWith(join(operatorHome, '.codex') + '/') ||
      home === join(operatorHome, '.codex-2') || home.startsWith(join(operatorHome, '.codex-2') + '/')) return null;
  try {
    if (await realpath(home) !== home || await realpath(join(home, '.codex')) !== join(home, '.codex')) return null;
    if (!(await stat(home)).isDirectory() || !(await stat(join(home, '.codex'))).isDirectory()) return null;
    return home;
  } catch { return null; }
}

/** Bounded metadata-only App Server exchange. No threads, auth calls or keys. */
async function readNativeStatus(home: string): Promise<unknown> {
  return new Promise(resolveResult => {
    const child = spawn('codex', NATIVE_ARGS, {
      cwd: home, shell: false,
      // Allowlist rather than copying ambient tokens, CODEX_HOME or proxy keys.
      env: { HOME: home, CODEX_HOME: join(home, '.codex'), PATH: process.env.PATH, LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let bytes = 0; let line = ''; let pending = 1; let ending = false; let closed = false; let failed = false;
    let result: unknown = null;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const finish = (value: unknown = null): void => {
      if (ending) return;
      ending = true; result = value;
      child.stdin.end();
    };
    const fail = (): void => {
      if (failed) return;
      failed = true;
      result = null;
      finish();
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (!closed) child.kill('SIGKILL');
    };
    // One deadline covers startup, the response, and native process exit.
    const timer = setTimeout(() => { fail(); resolveResult(null); }, TIMEOUT_MS);
    const send = (value: unknown): void => { child.stdin.write(JSON.stringify(value) + '\n'); };
    const message = (value: unknown): void => {
      if (!object(value)) { fail(); return; }
      if (typeof value.method === 'string') {
        // Never answer server requests (including credential refresh). Account
        // changes invalidate a pending reading instead of switching identity.
        if (Object.hasOwn(value, 'id') || value.method === 'account/updated') fail();
        return;
      }
      if (ending || value.id !== pending || Object.hasOwn(value, 'error') || !Object.hasOwn(value, 'result')) {
        fail(); return;
      }
      if (pending === 1) {
        if (!object(value.result) || value.result.codexHome !== join(home, '.codex')) { fail(); return; }
        send({ method: 'initialized' });
        pending = 2;
        send({ id: 2, method: 'account/rateLimits/read' });
      } else finish(value.result);
    };
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.on('error', () => { clearTimeout(timer); fail(); resolveResult(null); });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { fail(); return; }
      try {
        line += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = line.indexOf('\n')) >= 0) {
          const complete = line.slice(0, newline); line = line.slice(newline + 1);
          if (complete.trim()) message(JSON.parse(complete));
        }
      } catch { fail(); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Diagnostics may contain private data. Never retain or echo them.
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) fail();
    });
    child.on('close', (code, signal) => {
      closed = true; clearTimeout(timer);
      try { line += decoder.decode(); } catch { result = null; }
      resolveResult(code === 0 && !signal && !line.trim() ? result : null);
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'phantom-cmp-usage', version: '1' } } });
  });
}

/** Missing HOME, status, auth or readable quota means unknown, never a guess. */
export async function readCodexUsage(options: CodexUsageOptions = {}): Promise<CodexUsageReading> {
  let payload: unknown = null;
  try {
    const home = await cmpHome(options.home);
    if (home) payload = await readNativeStatus(home);
  } catch { /* Suppress native errors and private diagnostics. */ }
  const fetchedAt = new Date().toISOString();
  const reading: CodexUsageReading = {
    pool: 'codex-cmp', ...parseCodexUsage(payload, Date.parse(fetchedAt)), source: 'codex-reader', fetchedAt,
  };
  if (options.logPath) {
    const rows = [reading, { ...reading, pool: 'terra@cmp', resetAt: reading.terraResetAt }];
    await appendFile(options.logPath, rows.map(row => JSON.stringify({ ...row, used: row.pctUsed ?? 'unknown' }) + '\n').join(''),
      { mode: 0o600 });
  }
  return reading;
}
