/**
 * Anonymous install / weekly-active ping (docs/TELEMETRY.md).
 *
 * Separate from the local-first metrics store in ./telemetry.ts: this sends
 * exactly one tiny record so AshlrAI can count real installs instead of npm
 * downloads, which are dominated by our own machines, CI and mirrors.
 *
 * Sent fields (and nothing else): schema, event, tool, version, os, arch,
 * env (dev|ci), internal, install_id (random UUID made on first run).
 * Never sent: paths, repo names, hostnames, usernames, commands, args, env
 * values, tokens. IPs are not stored (the ashlr.ai ingest strips them).
 *
 * Opt out: ASHLR_TELEMETRY=0 (or false/off/no), DO_NOT_TRACK=1, or
 * `"disabled": true` in $ASHLR_HOME/usage-telemetry.json.
 * Fleet / founder machines: ASHLR_INTERNAL=1 or `"internal": true` in that file,
 * and any GitHub Actions run owned by ashlrai, are tagged internal and excluded
 * from public counts.
 *
 * Never throws, never blocks a command beyond a 1.5s network timeout, at most
 * one network call per week per install.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const USAGE_PING_ENDPOINT = 'https://ashlr.ai/api/telemetry';
export const USAGE_ACTIVE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const USAGE_RETRY_INTERVAL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 1500;

export interface UsageState {
  installId?: string;
  installSentAt?: string;
  lastActiveAt?: string;
  noticeShownAt?: string;
  lastAttemptAt?: string;
  disabled?: boolean;
  internal?: boolean;
}

export interface UsagePayload {
  schema: 1;
  event: 'install' | 'active';
  tool: string;
  version: string;
  os: string;
  arch: string;
  env: 'dev' | 'ci';
  internal: boolean;
  install_id: string;
}

export interface UsagePingDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetch?: typeof fetch;
  stateFile?: string;
  stderr?: { isTTY?: boolean; write: (s: string) => unknown };
  platform?: string;
  arch?: string;
}

const FALSEY = new Set(['0', 'false', 'off', 'no', 'disabled']);
const CI_VARS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'CODEBUILD_BUILD_ID', 'TEAMCITY_VERSION', 'BITBUCKET_BUILD_NUMBER', 'DRONE', 'VERCEL', 'NETLIFY'];

export function usageStateFile(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['ASHLR_HOME'];
  const home = typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured)
    ? configured : join(homedir(), '.ashlr');
  return join(home, 'usage-telemetry.json');
}

export function telemetryDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  const t = env['ASHLR_TELEMETRY']?.trim().toLowerCase();
  if (t !== undefined && FALSEY.has(t)) return true;
  const dnt = env['DO_NOT_TRACK']?.trim().toLowerCase();
  if (dnt !== undefined && dnt !== '' && !FALSEY.has(dnt)) return true;
  // Test runners never phone home.
  if (env['VITEST'] || env['NODE_ENV'] === 'test') return true;
  return false;
}

export function isCi(env: NodeJS.ProcessEnv): boolean {
  return CI_VARS.some((k) => {
    const v = env[k];
    return v !== undefined && v !== '' && !FALSEY.has(v.toLowerCase());
  });
}

export function isInternal(env: NodeJS.ProcessEnv, state: UsageState): boolean {
  const flag = env['ASHLR_INTERNAL']?.trim().toLowerCase();
  if (flag !== undefined && flag !== '' && !FALSEY.has(flag)) return true;
  if (env['GITHUB_REPOSITORY_OWNER']?.toLowerCase() === 'ashlrai') return true;
  return state.internal === true;
}

const token = (v: string) => (/^[a-z0-9_]{1,16}$/.test(v) ? v : 'other');
const version = (v: string) => (/^[0-9A-Za-z.+-]{1,40}$/.test(v) ? v : 'unknown');

function readState(file: string): UsageState {
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as UsageState : {};
  } catch {
    return {};
  }
}

function writeState(file: string, state: UsageState): boolean {
  try {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export const USAGE_NOTICE =
  'phm sends an anonymous install/weekly-active ping (tool, version, OS, arch, CI or not, random ID; ' +
  'no paths, repos, IPs or personal data). Opt out: ASHLR_TELEMETRY=0 or DO_NOT_TRACK=1. ' +
  'Details: https://github.com/ashlrai/phantom/blob/master/docs/TELEMETRY.md\n';

/** Decide what (if anything) to send. Pure apart from reading `state`. */
export function planUsagePing(state: UsageState, now: Date): 'install' | 'active' | null {
  if (!state.installSentAt) return 'install';
  const last = Date.parse(state.lastActiveAt ?? state.installSentAt);
  if (!Number.isFinite(last) || now.getTime() - last >= USAGE_ACTIVE_INTERVAL_MS) return 'active';
  return null;
}

/**
 * Best-effort ping. Resolves to the payload delivered (for tests) or null.
 * Callers should not await it on a hot path; it never rejects.
 */
export async function maybeSendUsagePing(tool: string, toolVersion: string, deps: UsagePingDeps = {}): Promise<UsagePayload | null> {
  try {
    const env = deps.env ?? process.env;
    if (telemetryDisabledByEnv(env)) return null;
    const file = deps.stateFile ?? usageStateFile(env);
    const state = readState(file);
    if (state.disabled === true) return null;
    const now = (deps.now ?? (() => new Date()))();
    const event = planUsagePing(state, now);
    if (!event) return null;

    const next: UsageState = { ...state, installId: state.installId ?? randomUUID() };
    const stderr = deps.stderr ?? process.stderr;
    if (!next.noticeShownAt && stderr.isTTY) {
      stderr.write(USAGE_NOTICE);
      next.noticeShownAt = now.toISOString();
    }
    // Persist the install id and attempt time first: if state cannot be
    // written, send nothing, so an unwritable home can never turn into a ping
    // on every run. Failed or interrupted sends retry at most hourly.
    const lastAttempt = Date.parse(state.lastAttemptAt ?? '');
    if (Number.isFinite(lastAttempt) && now.getTime() - lastAttempt < USAGE_RETRY_INTERVAL_MS) return null;
    next.lastAttemptAt = now.toISOString();
    if (!writeState(file, next)) return null;

    const payload: UsagePayload = {
      schema: 1,
      event,
      tool,
      version: version(toolVersion),
      os: token(deps.platform ?? process.platform),
      arch: token(deps.arch ?? process.arch),
      env: isCi(env) ? 'ci' : 'dev',
      internal: isInternal(env, state),
      install_id: next.installId!,
    };
    const endpoint = env['ASHLR_TELEMETRY_ENDPOINT']?.trim() || USAGE_PING_ENDPOINT;
    const doFetch = deps.fetch ?? fetch;
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null);
    if (!res || res.status >= 500) return null;
    // Delivered (or permanently rejected): record it so the next ping is a week away.
    if (event === 'install') next.installSentAt = now.toISOString();
    next.lastActiveAt = now.toISOString();
    writeState(file, next);
    return payload;
  } catch {
    return null;
  }
}
