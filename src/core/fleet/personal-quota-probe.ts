import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, parse, resolve, sep } from 'node:path';
import type { CodexSessionUsage, CodexSessionWindow } from './codex-session-usage.js';

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const denied = new Set(['rate_limit_reached', 'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted', 'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached']);
const failure = (): Error => new Error('Personal quota refresh unavailable');

/** Reject forbidden components before filesystem access, including intermediate symlink aliases. */
async function personalHome(home: string): Promise<string> {
  if (!isAbsolute(home) || home !== home.trim() || home.length > 4096 || /\p{Cc}/u.test(home) ||
      home.split(/[\\/]+/).some(p => p === '.codex' || p === '..') || resolve(home) === parse(home).root) throw failure();
  let prefix = parse(home).root;
  for (const part of home.slice(prefix.length).split(sep).filter(Boolean)) {
    prefix = resolve(prefix, part);
    const canonical = await realpath(prefix);
    if (canonical.split(/[\\/]+/).includes('.codex')) throw failure();
  }
  const canonical = await realpath(home);
  if (!(await stat(canonical)).isDirectory()) throw failure();
  return canonical;
}

// Validated against codex-cli 0.165.0 generate-ts (InitializeResponse,
// GetAccountRateLimitsResponse, RateLimitSnapshot, RateLimitWindow), and
// docs/research/provider-usage-probes.md. No auth, thread or turn requests.
function usage(payload: unknown): CodexSessionUsage {
  if (!object(payload)) throw failure();
  const bucket = payload.rateLimitsByLimitId != null
    ? object(payload.rateLimitsByLimitId) && payload.rateLimitsByLimitId.codex : payload.rateLimits;
  if (!object(bucket) || bucket.limitId !== 'codex') throw failure();
  const window = (v: unknown): CodexSessionWindow | null => {
    if (v == null) return null;
    if (!object(v) || typeof v.usedPercent !== 'number' || !Number.isFinite(v.usedPercent) ||
        v.usedPercent < 0 || v.usedPercent > 100 || typeof v.resetsAt !== 'number' ||
        !Number.isSafeInteger(v.resetsAt) || v.resetsAt <= Date.now() / 1000 || v.resetsAt > 253402300799 ||
        (v.windowDurationMins != null && (typeof v.windowDurationMins !== 'number' || !Number.isSafeInteger(v.windowDurationMins) || v.windowDurationMins <= 0))) throw failure();
    return { usedPercent: v.usedPercent, resetsAt: v.resetsAt, windowMinutes: v.windowDurationMins as number | null ?? null };
  };
  const primary = window(bucket.primary), secondary = window(bucket.secondary);
  if (!primary && !secondary) throw failure();
  const reached = bucket.rateLimitReachedType;
  if (reached != null && (typeof reached !== 'string' || !denied.has(reached))) throw failure();
  if (bucket.spendControlReached != null && typeof bucket.spendControlReached !== 'boolean') throw failure();
  if (payload.ordinaryUsageAllowed != null && typeof payload.ordinaryUsageAllowed !== 'boolean') throw failure();
  const individual = bucket.individualLimit;
  let individualLimit: CodexSessionUsage['individualLimit'] = null;
  if (individual != null) {
    if (!object(individual) || typeof individual.remainingPercent !== 'number' ||
        !Number.isFinite(individual.remainingPercent) || individual.remainingPercent < 0 || individual.remainingPercent > 100) throw failure();
    const reset = individual.resetsAt;
    if (reset != null && (typeof reset !== 'number' || !Number.isSafeInteger(reset) || reset <= Date.now() / 1000 || reset > 253402300799)) throw failure();
    individualLimit = { remainingPercent: individual.remainingPercent, resetsAt: reset as number | null ?? null };
  }
  return {
    accountId: 'codex-personal', slot: 'secondary', observedAt: new Date().toISOString(),
    primary, secondary, rateLimitReachedType: payload.ordinaryUsageAllowed === false ? 'rate_limit_reached' : reached as string | null ?? null,
    spendControlReached: bucket.spendControlReached as boolean | null ?? null, individualLimit,
    planType: null, limitId: null, limitName: null, model: null, originator: null, cliVersion: null, credits: null,
  };
}

/** One bounded read; native diagnostics and arbitrary provider fields never escape. */
export async function probePersonalQuota(selectedHome: string): Promise<CodexSessionUsage> {
  const home = await personalHome(selectedHome);
  return new Promise((resolveResult, reject) => {
    const child = spawn('codex', ['app-server', '--stdio', '-c', 'analytics.enabled=false'], {
      cwd: home, shell: false, env: { HOME: home, CODEX_HOME: home, PATH: process.env.PATH, LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let bytes = 0, line = '', pending = 1;
    let result: CodexSessionUsage | undefined;
    let failed = false, closed = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const fail = (): void => {
      failed = true;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (!closed) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { fail(); reject(failure()); }, 8000);
    const send = (v: unknown): void => { child.stdin.write(JSON.stringify(v) + '\n'); };
    child.stdin.on('error', fail); child.stdout.on('error', fail); child.stderr.on('error', fail);
    child.on('error', () => { clearTimeout(timer); fail(); reject(failure()); });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) { fail(); return; }
      try {
        line += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = line.indexOf('\n')) >= 0) {
          const raw = line.slice(0, newline); line = line.slice(newline + 1);
          if (!raw.trim()) continue;
          const v: unknown = JSON.parse(raw);
          if (!object(v)) throw failure();
          if (typeof v.method === 'string') {
            if (Object.hasOwn(v, 'id') || v.method === 'account/updated') throw failure();
            continue;
          }
          if (result || v.id !== pending || Object.hasOwn(v, 'error') || !object(v.result)) throw failure();
          if (pending === 1) {
            if (v.result.codexHome !== home) throw failure();
            send({ method: 'initialized' }); pending = 2;
            send({ id: 2, method: 'account/rateLimits/read' });
          } else { result = usage(v.result); child.stdin.end(); }
        }
      } catch { fail(); }
    });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256 * 1024) fail(); });
    child.on('close', (code, signal) => {
      closed = true; clearTimeout(timer);
      try { line += decoder.decode(); } catch { failed = true; }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (failed || code !== 0 || signal || line.trim() || !result) reject(failure());
      else resolveResult(result);
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'phantom-personal-quota', version: '1' } } });
  });
}
