/** Advertised CLI capabilities only: never authentication, quota, inference or execution readiness. */
import { isAbsolute, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runVerifySubprocessAsync } from '../run/verify-commands.js';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { workerEnvironment } from './worker.js';

export type ResourceLauncherProvider = 'codex' | 'claude' | 'grok';
export interface ResourceLauncherCompatibilityOptions {
  provider: ResourceLauncherProvider;
  /** Explicit operator-owned executable/wrapper prefix, not model-generated input. */
  command: string[];
  /** Existing owned canonical private directory, outside a candidate workspace. */
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export type ResourceLauncherCompatibilityReason = 'launcher-flags-advertised' | 'launcher-required-flags-missing' |
  'launcher-version-incompatible' | 'launcher-hub-transport-not-implemented' | 'launcher-upstream-capability-unverified' |
  'launcher-process-failed' | 'launcher-output-limit' | 'launcher-timed-out' | 'launcher-cancelled' |
  'launcher-termination-uncertain' | 'launcher-directory-unavailable' | 'launcher-platform-unsupported';
export interface ResourceLauncherCompatibilityResult {
  schemaVersion: 1;
  scope: 'native-cli-help';
  provider: ResourceLauncherProvider;
  status: 'supported' | 'incompatible' | 'unavailable';
  reason: ResourceLauncherCompatibilityReason;
  /** Recognized numeric version only; unknown formats are not echoed or guessed. */
  version: string | null;
  requiredFlags: string[];
  observedFlags: string[];
  missingFlags: string[];
  hubTransport: 'native-cli' | 'not-implemented';
  upstreamTransport: 'native-cli' | 'acp';
  upstreamCapability: 'advertised' | 'unverified';
  startedAt: string;
  finishedAt: string;
}

const REQUIRED: Record<ResourceLauncherProvider, readonly string[]> = {
  codex: ['--model', '--cd', '--sandbox', '--json', '--ephemeral', '--ignore-user-config'],
  claude: ['--print', '--model', '--output-format', '--verbose', '--no-session-persistence',
    '--safe-mode', '--restricted', '--strict-mcp-config', '--tools', '--permission-mode'],
  grok: ['--help'],
};
const MAX_OUTPUT = 64 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4_096 &&
    [...value].every((character) => { const code = character.charCodeAt(0); return code >= 32 && (code < 127 || code > 159); });
}
function configuration(options: ResourceLauncherCompatibilityOptions) {
  const invalid = (): never => { throw new Error('Invalid resource launcher compatibility configuration'); };
  if (!record(options)) return invalid();
  const keys = Reflect.ownKeys(options);
  if (!['provider', 'command', 'cwd'].every((key) => keys.includes(key)) ||
    !keys.every((key) => typeof key === 'string' && ['provider', 'command', 'cwd', 'timeoutMs', 'signal'].includes(key) &&
      'value' in Object.getOwnPropertyDescriptor(options, key)!)) return invalid();
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!['codex', 'claude', 'grok'].includes(options.provider) || !Array.isArray(options.command) ||
    options.command.length < 1 || options.command.length > 32 ||
    Reflect.ownKeys(options.command).length !== options.command.length + 1 ||
    !Array.from({ length: options.command.length }, (_, i) => i).every((i) => Object.hasOwn(options.command, i) &&
      'value' in Object.getOwnPropertyDescriptor(options.command, i)! && text(options.command[i])) ||
    !isAbsolute(options.command[0]!) || options.command.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 16 * 1024 ||
    !text(options.cwd) || !isAbsolute(options.cwd) || resolve(options.cwd) !== options.cwd || parse(options.cwd).root === options.cwd ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))) return invalid();
  inspectPrivateDirectory(options.cwd);
  return { provider: options.provider, command: [...options.command], cwd: options.cwd, timeoutMs, signal: options.signal };
}

/** Only declaration lines in a conventional Options section count, never prose or examples. */
export function resourceLauncherDeclaredFlags(output: string, required: readonly string[]): string[] {
  let options = false;
  const flags = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (/^Options:\s*$/.test(line)) { options = true; continue; }
    if (!options) continue;
    if (/^\S/.test(line)) { options = false; continue; }
    const flag = /^\s+(?:-[A-Za-z0-9?],?\s+)?(--[a-z][a-z0-9-]*)(?=\s|=|,|\[|$)/.exec(line)?.[1];
    if (flag && required.includes(flag)) flags.add(flag);
  }
  return required.filter((flag) => flags.has(flag));
}
/** Command declarations only; descriptions, examples and prefix matches earn no evidence. */
export function resourceLauncherDeclaredCommands(output: string): string[] {
  let commands = false;
  const observed = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (/^Commands:\s*$/.test(line)) { commands = true; continue; }
    if (!commands) continue;
    if (/^\S/.test(line)) { commands = false; continue; }
    const name = /^\s+([a-z][a-z0-9-]*)(?:\s{2,}|\s*$)/.exec(line)?.[1];
    if (name) observed.add(name);
  }
  return [...observed];
}
function advertisedCommand(output: string, command: 'agent' | 'stdio'): boolean {
  return resourceLauncherDeclaredCommands(output).includes(command);
}
export function resourceLauncherVersion(provider: ResourceLauncherProvider, output: string): string | null {
  const number = '(\\d{1,6}\\.\\d{1,6}\\.\\d{1,6})';
  const pattern = provider === 'codex' ? `^codex-cli ${number}(?:-[a-z0-9.-]{1,32})?$`
    : provider === 'claude' ? `^${number} \\(Claude Code\\)$`
      : `^grok ${number}(?: \\([a-f0-9]{7,40}\\))?$`;
  return new RegExp(pattern).exec(output.trim())?.[1] ?? null;
}
function olderClaude(version: string | null): boolean {
  if (version === null) return false;
  const parts = version.split('.').map(Number);
  const floor = [2, 1, 248];
  for (let i = 0; i < floor.length; i++) {
    if (parts[i] !== floor[i]) return parts[i]! < floor[i]!;
  }
  return false;
}

export type ResourceLauncherHelpTopic = 'version' | 'global' | 'codex-exec' | 'codex-app-server' |
  'claude-agents' | 'grok-agent' | 'grok-stdio';

function helpTopicArguments(provider: ResourceLauncherProvider, topic: ResourceLauncherHelpTopic): string[] {
  if (topic === 'version') return ['--version'];
  if (topic === 'global') return ['--help'];
  if (provider === 'codex' && topic === 'codex-exec') return ['exec', '--help'];
  if (provider === 'codex' && topic === 'codex-app-server') return ['app-server', '--help'];
  if (provider === 'claude' && topic === 'claude-agents') return ['agents', '--help'];
  if (provider === 'grok' && topic === 'grok-agent') return ['agent', '--help'];
  if (provider === 'grok' && topic === 'grok-stdio') return ['agent', 'stdio', '--help'];
  throw new Error('Unsupported launcher help topic');
}

/** Shared trusted-launcher probe: four fixed help/version requests under one deadline. */
export function createResourceLauncherHelpProbe(options: ResourceLauncherCompatibilityOptions) {
  let pinned: ReturnType<typeof configuration>;
  try { pinned = configuration(options); } catch { throw new Error('Invalid resource launcher compatibility configuration'); }
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let failure: ResourceLauncherCompatibilityReason | undefined;
  let calls = 0;
  const invoke = async (topic: ResourceLauncherHelpTopic): Promise<string | null> => {
    const suffix = helpTopicArguments(pinned.provider, topic);
    if (++calls > 4) throw new Error('Help probe invocation limit');
    if (failure) return null;
    if (process.platform === 'win32') { failure = 'launcher-platform-unsupported'; return null; }
    if (pinned.signal?.aborted) { failure = 'launcher-cancelled'; return null; }
    const remaining = Math.floor(pinned.timeoutMs - (performance.now() - started));
    if (remaining < 1) { failure = 'launcher-timed-out'; return null; }
    try { inspectPrivateDirectory(pinned.cwd); } catch { failure = 'launcher-directory-unavailable'; return null; }
    try {
      const processResult = await runVerifySubprocessAsync([
        ...pinned.command, ...(pinned.provider === 'grok' ? ['--no-auto-update'] : []), ...suffix,
      ], {
        cwd: pinned.cwd, env: workerEnvironment(), timeoutMs: remaining, maxOutputChars: MAX_OUTPUT, signal: pinned.signal,
      });
      if (processResult.error?.startsWith('termination authority lost:') ||
        processResult.error === 'termination deadline elapsed with process-group exit unconfirmed') failure = 'launcher-termination-uncertain';
      else if (processResult.cancelled || pinned.signal?.aborted) failure = 'launcher-cancelled';
      else if (processResult.timedOut || performance.now() - started >= pinned.timeoutMs) failure = 'launcher-timed-out';
      else if (processResult.outputTruncated || Buffer.byteLength(processResult.stdout) > MAX_OUTPUT ||
        Buffer.byteLength(processResult.stderr) > MAX_OUTPUT) failure = 'launcher-output-limit';
      else if (processResult.error || processResult.exitCode !== 0 || processResult.signal) failure = 'launcher-process-failed';
      return failure ? null : processResult.stdout;
    } catch { failure = 'launcher-process-failed'; return null; }
  };
  return { provider: pinned.provider, startedAt, invoke, failure: () => failure };
}

/**
 * At most four sequential help/version invocations under one shared deadline.
 * Trusted wrappers/native startup may maintain their own configuration; this is
 * not a sandbox or account/billing check. No auth command, ACP initialization,
 * prompt, model request, credential selection, update or installation is requested.
 */
export async function checkResourceLauncherCompatibility(
  options: ResourceLauncherCompatibilityOptions,
): Promise<ResourceLauncherCompatibilityResult> {
  const probe = createResourceLauncherHelpProbe(options);
  const provider = probe.provider;
  const required = [...REQUIRED[provider]];
  let version: string | null = null;
  const result = (status: ResourceLauncherCompatibilityResult['status'], reason: ResourceLauncherCompatibilityReason,
    observed: string[] = [], advertised = false): ResourceLauncherCompatibilityResult => ({
    schemaVersion: 1, scope: 'native-cli-help', provider, status, reason, version,
    requiredFlags: [...required], observedFlags: [...observed], missingFlags: required.filter((flag) => !observed.includes(flag)),
    hubTransport: provider === 'grok' ? 'not-implemented' : 'native-cli',
    upstreamTransport: provider === 'grok' ? 'acp' : 'native-cli',
    upstreamCapability: advertised ? 'advertised' : 'unverified', startedAt: probe.startedAt, finishedAt: new Date().toISOString(),
  });
  if (options.signal?.aborted) return result('unavailable', 'launcher-cancelled');
  if (process.platform === 'win32') return result('unavailable', 'launcher-platform-unsupported');
  const versionOutput = await probe.invoke('version');
  if (versionOutput === null) return result('unavailable', probe.failure()!);
  version = resourceLauncherVersion(provider, versionOutput);
  let help = await probe.invoke(provider === 'codex' ? 'codex-exec' : 'global');
  if (help === null) return result('unavailable', probe.failure()!);
  if (provider === 'grok') {
    if (!advertisedCommand(help, 'agent')) return result('incompatible', 'launcher-upstream-capability-unverified');
    help = await probe.invoke('grok-agent');
    if (help === null) return result('unavailable', probe.failure()!);
    if (!advertisedCommand(help, 'stdio')) return result('incompatible', 'launcher-upstream-capability-unverified');
    help = await probe.invoke('grok-stdio');
    if (help === null) return result('unavailable', probe.failure()!);
    const flags = resourceLauncherDeclaredFlags(help, required);
    const advertised = /^Usage: grok agent stdio(?: \[OPTIONS\])?\s*$/m.test(help) && flags.length === required.length;
    return result('incompatible', advertised ? 'launcher-hub-transport-not-implemented' : 'launcher-upstream-capability-unverified', flags, advertised);
  }
  const flags = resourceLauncherDeclaredFlags(help, required);
  if (flags.length !== required.length) return result('incompatible', 'launcher-required-flags-missing', flags);
  if (provider === 'claude' && olderClaude(version)) return result('incompatible', 'launcher-version-incompatible', flags);
  return result('supported', 'launcher-flags-advertised', flags, true);
}
