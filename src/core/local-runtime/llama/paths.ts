/**
 * Where the supervised llama-server runtime keeps its own state.
 *
 * Every path is re-resolved from `homedir()` at call time (the convention in
 * src/core/config.ts) so a relocated HOME — a test, a different user — is
 * always honoured. Nothing here ever touches ~/.ashlr/config.json,
 * ~/.ashlr/enrollment.json or ~/.ashlr/KILL: this family reads those and owns
 * none of them.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `~/.ashlr` — the hub root. */
function ashlrHome(): string {
  return join(homedir(), '.ashlr');
}

/** `~/.ashlr/local-runtime` — this runtime's private state directory. */
export function localRuntimeDir(): string {
  return join(ashlrHome(), 'local-runtime');
}

/** `~/.ashlr/local-runtime/llama-server.json` — the ownership record. */
export function ownershipRecordPath(): string {
  return join(localRuntimeDir(), 'llama-server.json');
}

/**
 * `~/.ashlr/local-runtime/llama-server-launch.sh` — the launch agent's shim.
 *
 * launchd runs THIS rather than llama-server directly. See
 * {@link import('./launchd.js').buildLaunchAgentShim} for why: Ollama's blob
 * store is content-addressed, so a frozen `sha256-…` path in the plist dies
 * permanently on the next `ollama pull`.
 */
export function launchAgentShimPath(): string {
  return join(localRuntimeDir(), 'llama-server-launch.sh');
}

/** `~/.ashlr/logs` — where a supervised process's stdout/stderr land. */
export function logsDir(): string {
  return join(ashlrHome(), 'logs');
}

/** Absolute stdout log path for the supervised runtime. */
export function stdoutLogPath(): string {
  return join(logsDir(), 'local-runtime.out.log');
}

/** Absolute stderr log path for the supervised runtime. */
export function stderrLogPath(): string {
  return join(logsDir(), 'local-runtime.err.log');
}

/**
 * `~/.ashlr/local-runtime/anthropic-proxy-launch.sh` — the proxy job's shim.
 *
 * A SECOND shim rather than more flags on the llama-server one, because the
 * two jobs have genuinely independent lifetimes: llama-server is a foreign
 * binary that must keep running while the proxy is restarted for a config
 * change, and a single job cannot supervise two processes.
 */
export function anthropicProxyShimPath(): string {
  return join(localRuntimeDir(), 'anthropic-proxy-launch.sh');
}

/** Absolute stdout log path for the supervised Anthropic proxy. */
export function anthropicProxyStdoutLogPath(): string {
  return join(logsDir(), 'anthropic-proxy.out.log');
}

/** Absolute stderr log path for the supervised Anthropic proxy. */
export function anthropicProxyStderrLogPath(): string {
  return join(logsDir(), 'anthropic-proxy.err.log');
}

/** launchd job label. Reverse-DNS, matching the hub's other agents. */
export const LAUNCH_AGENT_LABEL = 'ai.ashlr.local-runtime';

/** launchd job label for the Anthropic normalising proxy. */
export const ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL = 'ai.ashlr.anthropic-proxy';

function launchAgentPlistForLabel(label: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

/** `~/Library/LaunchAgents/ai.ashlr.anthropic-proxy.plist`. */
export function anthropicProxyPlistPath(): string {
  return launchAgentPlistForLabel(ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL);
}

/**
 * `~/Library/LaunchAgents/ai.ashlr.local-runtime.plist`.
 *
 * This path is OUTSIDE the repository and outside ~/.ashlr. Writing it changes
 * the machine's login-time behaviour, so it only ever happens behind an
 * explicit `--install` and the path is printed to the operator.
 */
export function launchAgentPlistPath(): string {
  return launchAgentPlistForLabel(LAUNCH_AGENT_LABEL);
}

/**
 * Ollama's model store root. `OLLAMA_MODELS` wins when set, exactly as the
 * Ollama server itself resolves it; otherwise `~/.ollama/models`.
 */
export function ollamaModelsRoot(): string {
  const override = process.env['OLLAMA_MODELS']?.trim();
  if (override) return override;
  return join(homedir(), '.ollama', 'models');
}

// ---------------------------------------------------------------------------
// Shared primitive guards and bounded-file readers for the local-runtime family.
// ---------------------------------------------------------------------------

/** True when `value` is a non-null, non-array object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` is a safe integer >= 0. */
export function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** True when `value` is a safe integer > 0. */
export function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Extract a human-readable error message without throwing. */
export function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when `path` resolves to a regular file. Never throws. */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Read and parse a small regular JSON file up to `maxBytes`.
 * Returns null on absence, non-regular file, size overflow or parse failure.
 */
export function readBoundedJsonFile(path: string, maxBytes: number): unknown | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}
