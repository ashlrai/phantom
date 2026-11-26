/**
 * core/mcp-doctor.ts — health diagnosis for `phm mcp doctor`.
 * Probes downstreams via `probeServer()`; verifies recognized Phantom
 * self-gateway launchers (`ashlr-hub` / legacy `ashlr`) non-recursively via
 * `--version` (and `mcp list --json` on version mismatch). Opaque wrappers and
 * secret-like argv stay refused; `probeServer()`'s recursion guard is unchanged.
 */

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpServerHealth, McpServerSpec } from './types.js';
import { GATEWAY_ENV_MARKER, gatewayVersion, isSelfGateway, probeServer } from './mcp-gateway.js';
import { hasSecretLikeArgv, redactedCommand } from './mcp-argv-safety.js';
import { nativeToolDefs } from './mcp-native.js';
import { scrubSecrets } from './util/scrub.js';
import { getLocusJobEnv, withLocusJobChildEnv } from './integrations/locus-job-env.js';

const DEFAULT_DOCTOR_TIMEOUT_MS = 8_000;
const VERSION_MAX_BUFFER = 64 * 1024;
const LIST_MAX_BUFFER = 2 * 1024 * 1024;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const SAFE_ENV_KEYS = [
  'HOME', 'USERPROFILE', 'ASHLR_HOME', 'PATH', 'PATHEXT', 'SHELL', 'TERM',
  'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'COMSPEC',
] as const;

export const REQUIRED_MCP_DOCTOR_SERVERS: ReadonlySet<string> = new Set([
  'ashlr-hub', 'ashlr', 'phantom-secrets', 'locus',
]);

export type SelfGatewayLauncher =
  | { kind: 'recognized'; command: string; prefixArgs: string[] }
  | { kind: 'invalid-args'; error: string }
  | { kind: 'opaque' };

export interface LauncherVersionCheckResult { ok: boolean; version?: string; error?: string; }
export interface LauncherNativeListResult { ok: boolean; tools: string[]; error?: string; }
export interface McpDoctorServerResult { health: McpServerHealth; selfGateway: boolean; gatewayVersion?: string; versionMismatch?: string; }

export interface McpDoctorDeps {
  probe?: (spec: McpServerSpec, timeoutMs?: number) => Promise<McpServerHealth>;
  nativeTools?: () => string[];
  currentVersion?: () => string;
  runVersionCheck?: (command: string, args: string[], env: Record<string, string>, timeoutMs: number) => Promise<LauncherVersionCheckResult>;
  runNativeList?: (command: string, args: string[], env: Record<string, string>, timeoutMs: number) => Promise<LauncherNativeListResult>;
  onCheck?: (spec: McpServerSpec, selfGateway: boolean) => void;
}

const executableName = (value: string): string =>
  (value.split(/[\\/]/).pop() ?? value).replace(/\.(?:cmd|exe)$/i, '').toLowerCase();

function isOwnCliEntry(arg: string): boolean {
  const name = executableName(arg);
  return name === 'ashlr' || name === 'phm'
    || resolve(arg) === fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url))
    || resolve(arg) === fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
}

function isValidGatewayTrailingArgs(afterMcp: readonly string[]): boolean {
  if (afterMcp.length === 0) return true;
  if (afterMcp.length === 1) return afterMcp[0] === 'run' || afterMcp[0] === '--lazy';
  return afterMcp.length === 2 && afterMcp[0] === 'run' && afterMcp[1] === '--lazy';
}

export function resolveSelfGatewayLauncher(spec: McpServerSpec): SelfGatewayLauncher {
  const mcpIndex = spec.args.indexOf('mcp');
  if (mcpIndex < 0) return { kind: 'opaque' };
  const cmd = executableName(spec.command);
  const afterMcp = spec.args.slice(mcpIndex + 1);
  const invalid = { kind: 'invalid-args' as const, error: `invalid gateway args for "${spec.name}": expected "mcp [run] [--lazy]"` };

  if (cmd === 'ashlr' || cmd === 'phm') {
    return mcpIndex === 0 && isValidGatewayTrailingArgs(afterMcp)
      ? { kind: 'recognized', command: spec.command, prefixArgs: [] }
      : invalid;
  }
  if (cmd === 'node' || cmd === 'bun' || cmd === 'tsx') {
    const prefix = spec.args.slice(0, mcpIndex);
    if (!prefix.some((arg) => isOwnCliEntry(arg))) return { kind: 'opaque' };
    return mcpIndex >= 1 && isOwnCliEntry(spec.args[mcpIndex - 1]!) && isValidGatewayTrailingArgs(afterMcp)
      ? { kind: 'recognized', command: spec.command, prefixArgs: prefix }
      : invalid;
  }
  return { kind: 'opaque' };
}

function buildSafeLauncherEnv(spec: McpServerSpec): Record<string, string> {
  const base: NodeJS.ProcessEnv = {};
  const locusEnv = getLocusJobEnv();
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) base[key] = process.env[key];
    if (locusEnv[key] !== undefined) base[key] = locusEnv[key];
  }
  const merged = withLocusJobChildEnv({ ...base, ...(spec.env ?? {}), [GATEWAY_ENV_MARKER]: '1', NO_COLOR: '1' });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

type ExecErr = NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };

function formatLauncherFailure(command: string, err: ExecErr, stderr: string, timeoutMs: number): string {
  if (err.code === 'ENOENT') return `gateway launcher "${command}" not found on PATH (install @ashlr/phantom or run ./install.sh)`;
  const cleanStderr = scrubSecrets(stderr);
  if (cleanStderr.includes('ERR_MODULE_NOT_FOUND') && /dist[\\/]cli[\\/]index\.js/.test(cleanStderr)) {
    return `gateway launcher "${command}" cannot load dist/cli/index.js (run npm run build)`;
  }
  if (err.killed || err.signal === 'SIGKILL' || err.signal === 'SIGTERM') {
    return `gateway launcher "${command}" timed out after ${timeoutMs}ms`;
  }
  const detail = cleanStderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? scrubSecrets(err.message);
  return `gateway launcher check failed: ${detail}`;
}

function execSafe(command: string, args: string[], env: Record<string, string>, timeoutMs: number, maxBuffer: number) {
  return new Promise<{ err: ExecErr | null; stdout: string; stderr: string }>((done) => {
    execFile(command, args, { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer, windowsHide: true, env }, (err, stdout, stderr) => {
      done({ err: err as ExecErr | null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

async function defaultRunVersionCheck(command: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<LauncherVersionCheckResult> {
  const { err, stdout, stderr } = await execSafe(command, args, env, timeoutMs, VERSION_MAX_BUFFER);
  if (err) return { ok: false, error: formatLauncherFailure(command, err, stderr, timeoutMs) };
  const firstLine = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return SEMVER_RE.test(firstLine)
    ? { ok: true, version: firstLine }
    : { ok: false, error: `gateway launcher "${command}" did not report a Phantom version` };
}

async function defaultRunNativeList(command: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<LauncherNativeListResult> {
  const { err, stdout, stderr } = await execSafe(command, args, env, timeoutMs, LIST_MAX_BUFFER);
  if (err) return { ok: false, tools: [], error: formatLauncherFailure(command, err, stderr, timeoutMs) };
  try {
    const parsed = JSON.parse(stdout.trim()) as { native?: unknown };
    if (parsed.native === undefined) return { ok: true, tools: [] };
    if (!Array.isArray(parsed.native)) return { ok: false, tools: [], error: `gateway launcher "${command}" returned an invalid native tool inventory` };
    const tools: string[] = [];
    for (const entry of parsed.native) {
      if (!entry || typeof entry !== 'object' || typeof (entry as { name?: unknown }).name !== 'string') {
        return { ok: false, tools: [], error: `gateway launcher "${command}" returned an invalid native tool entry` };
      }
      tools.push((entry as { name: string }).name);
    }
    return { ok: true, tools };
  } catch {
    return { ok: false, tools: [], error: `gateway launcher "${command}" returned non-JSON from mcp list --json` };
  }
}

const failSelf = (name: string, error: string, extra: Pick<McpDoctorServerResult, 'gatewayVersion' | 'versionMismatch'> = {}): McpDoctorServerResult =>
  ({ selfGateway: true, ...extra, health: { name, ok: false, toolCount: 0, tools: [], error } });

export async function diagnoseMcpServer(
  spec: McpServerSpec,
  timeoutMs: number = DEFAULT_DOCTOR_TIMEOUT_MS,
  deps: McpDoctorDeps = {},
): Promise<McpDoctorServerResult> {
  const probe = deps.probe ?? probeServer;
  const selfGateway = isSelfGateway(spec);
  deps.onCheck?.(spec, selfGateway);
  if (!selfGateway) return { health: await probe(spec, timeoutMs), selfGateway: false };
  if (hasSecretLikeArgv(spec.args)) {
    return failSelf(spec.name, `unsafe MCP argv refused for "${spec.name}": ${redactedCommand(spec.command, spec.args)} (move credentials to env, Phantom, or a wrapper/config file)`);
  }
  const launcher = resolveSelfGatewayLauncher(spec);
  if (launcher.kind === 'invalid-args') return failSelf(spec.name, launcher.error);
  if (launcher.kind === 'opaque') return { health: await probe(spec, timeoutMs), selfGateway: true };

  let env: Record<string, string>;
  try { env = buildSafeLauncherEnv(spec); } catch (err) {
    return failSelf(spec.name, scrubSecrets(err instanceof Error ? err.message : String(err)));
  }

  const startedAt = Date.now();
  const versionCheck = await (deps.runVersionCheck ?? defaultRunVersionCheck)(launcher.command, [...launcher.prefixArgs, '--version'], env, timeoutMs);
  if (!versionCheck.ok || !versionCheck.version) {
    return failSelf(spec.name, versionCheck.error ?? `gateway launcher "${launcher.command}" check failed`);
  }
  const currentVer = (deps.currentVersion ?? gatewayVersion)();
  if (versionCheck.version === currentVer) {
    const tools = (deps.nativeTools ?? (() => nativeToolDefs().map((t) => t.name)))();
    return { selfGateway: true, gatewayVersion: versionCheck.version, health: { name: spec.name, ok: true, toolCount: tools.length, tools } };
  }
  const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));
  const listResult = await (deps.runNativeList ?? defaultRunNativeList)(launcher.command, [...launcher.prefixArgs, 'mcp', 'list', '--json'], env, remainingMs);
  if (!listResult.ok) {
    return failSelf(spec.name, listResult.error ?? `gateway launcher "${launcher.command}" mcp list failed`, { gatewayVersion: versionCheck.version, versionMismatch: currentVer });
  }
  return {
    selfGateway: true, gatewayVersion: versionCheck.version, versionMismatch: currentVer,
    health: { name: spec.name, ok: true, toolCount: listResult.tools.length, tools: listResult.tools },
  };
}

export async function diagnoseMcpServers(
  servers: readonly McpServerSpec[],
  timeoutMs: number = DEFAULT_DOCTOR_TIMEOUT_MS,
  deps: McpDoctorDeps = {},
): Promise<McpDoctorServerResult[]> {
  const settled = await Promise.allSettled(servers.map((srv) => diagnoseMcpServer(srv, timeoutMs, deps)));
  return settled.map((result, idx) => {
    if (result.status === 'fulfilled') return result.value;
    const srv = servers[idx]!;
    return {
      selfGateway: isSelfGateway(srv),
      health: { name: srv.name, ok: false, toolCount: 0, tools: [], error: scrubSecrets(result.reason instanceof Error ? result.reason.message : String(result.reason)) },
    };
  });
}

export function hasRequiredMcpServerDown(results: readonly McpServerHealth[]): boolean {
  return results.some((h) => REQUIRED_MCP_DOCTOR_SERVERS.has(h.name) && !h.ok);
}
