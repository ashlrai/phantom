/**
 * core/connect/deps.ts: real implementations of the connect seams.
 *
 * Everything here obeys two rules:
 *   - No shell: every subprocess runs by argv with a bounded timeout and a
 *     bounded output buffer, and never throws.
 *   - Secret values travel on stdin only (`phantom add <name> --stdin`),
 *     never on argv, never to stdout/stderr, never to disk outside the vault.
 */

import { spawnSync } from 'node:child_process';
import { hostname as osHostname } from 'node:os';
import { scrubSecrets } from '../util/scrub.js';
import type { ConnectDeps, ConnectProbeResult, ConnectSecretOutcome } from './types.js';

const OUTPUT_MAX_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const PHANTOM_TIMEOUT_MS = 15_000;

function run(argv: readonly string[], opts: { timeoutMs?: number } = {}): ConnectProbeResult {
  try {
    const result = spawnSync(argv[0]!, [...argv.slice(1)], {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: OUTPUT_MAX_BYTES,
      env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1', NO_COLOR: '1', CI: '1' },
    });
    if (result.error) {
      return { status: null, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error.message };
    }
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (err) {
    return { status: null, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) };
  }
}

function runInteractive(argv: readonly string[]): number {
  try {
    const result = spawnSync(argv[0]!, [...argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
      timeout: 10 * 60_000,
    });
    return result.status ?? (result.error ? 1 : 0);
  } catch {
    return 1;
  }
}

/** First line of process output, scrubbed and capped, for a value-free reason. */
function failureReason(r: ConnectProbeResult): string {
  const line = (r.stderr.trim() || r.stdout.trim() || r.error || 'command failed')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '') ?? 'command failed';
  return scrubSecrets(line).slice(0, 160);
}

/**
 * `phantom add <name> --stdin`: the value is piped to the child on stdin and
 * is never repeated to us. Phantom refuses existing names, which is the
 * desired fail-closed behaviour (a grant never silently replaces a secret).
 */
function storeSecret(name: string, value: string): ConnectSecretOutcome {
  try {
    const result = spawnSync('phantom', ['add', name, '--stdin'], {
      encoding: 'utf8',
      input: value,
      timeout: PHANTOM_TIMEOUT_MS,
      maxBuffer: OUTPUT_MAX_BYTES,
      env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
    });
    if (result.error) return { ok: false, reason: result.error.message };
    if (result.status !== 0) {
      return { ok: false, reason: failureReason({ status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `phantom remove <name>`: best-effort. The trusted-terminal challenge may
 * refuse non-interactively; the grant revocation still lands and the audit
 * entry records the outcome.
 */
function removeSecret(name: string): ConnectSecretOutcome {
  try {
    const result = spawnSync('phantom', ['remove', name], {
      encoding: 'utf8',
      // The trusted-terminal challenge fails fast on EOF rather than hanging.
      input: '',
      timeout: PHANTOM_TIMEOUT_MS,
      maxBuffer: OUTPUT_MAX_BYTES,
      env: { ...process.env, PHANTOM_NO_UPDATE_CHECK: '1' },
    });
    if (result.error) return { ok: false, reason: result.error.message };
    if (result.status !== 0) {
      return { ok: false, reason: failureReason({ status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function defaultConnectDeps(mcpServers: () => readonly { name: string; command: string }[]): ConnectDeps {
  return {
    run,
    runInteractive,
    storeSecret,
    removeSecret,
    mcpServers,
    hostname: () => osHostname(),
    now: () => new Date(),
  };
}
