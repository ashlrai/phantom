/**
 * integrations/stack.ts — M69: detect + read the ecosystem `stack` tool
 * (service control plane: OAuth → provider → secrets, Phantom-wired).
 *
 * READ-ONLY / ADVISORY by design: the hub DETECTS stack and reports status so an
 * agent or the operator knows what services are wired — it never auto-provisions
 * (`stack apply` stays a deliberate, user-initiated action). Never throws.
 *
 * M73: adds stackRun() — a bounded, never-throw passthrough runner used by the
 * `ashlr stack` CLI layer. Mutating actions (add/apply) are gated at the CLI
 * layer BEFORE calling stackRun; the runner itself is intentionally neutral.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const STACK_BIN = 'stack';
const TIMEOUT_MS = 5_000;
/** Mutating actions (add/apply) may prompt and run an OAuth round-trip. */
const INTERACTIVE_TIMEOUT_MS = 10 * 60_000;

/** Whether the `stack` CLI is on PATH. Never throws. */
export function stackInstalled(): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(probe, [STACK_BIN], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/** Whether a repo has a committed stack config (.stack.toml). Never throws. */
export function stackProjectConfigured(repo: string): boolean {
  try {
    return existsSync(join(repo, '.stack.toml'));
  } catch {
    return false;
  }
}

export interface StackStatus {
  ok: boolean;
  /** Service names stack reports as wired (best-effort parse). */
  services?: string[];
  detail: string;
}

/**
 * Service names declared in a repo's committed .stack.toml (`[services.<name>]`
 * table headers), or null when the file is absent/unreadable. Never throws.
 */
export function stackConfiguredServices(repo: string): string[] | null {
  try {
    const text = readFileSync(join(repo, '.stack.toml'), 'utf8');
    const names: string[] = [];
    for (const m of text.matchAll(/^[ \t]*\[services\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\][ \t]*(?:#.*)?\r?$/gm)) {
      const name = m[1] ?? m[2];
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  } catch {
    return null;
  }
}

/**
 * Read `stack status --json` for a repo (best-effort). ok:false (never throws)
 * when stack is absent, errors, or times out. When the payload is not JSON
 * (Stack versions without `status --json`), falls back to the service names
 * declared in the repo's .stack.toml; ok:false only when neither works.
 */
export function stackStatus(repo?: string): StackStatus {
  if (!stackInstalled()) return { ok: false, detail: 'stack not installed' };
  try {
    const res = spawnSync(STACK_BIN, ['status', '--json'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env },
    });
    if (res.status !== 0 || res.error) {
      return { ok: false, detail: `stack status exit ${res.status ?? 'error'}` };
    }
    const out = (res.stdout ?? '').trim();
    try {
      const parsed = JSON.parse(out) as Record<string, unknown>;
      const raw = parsed['services'];
      const services = Array.isArray(raw)
        ? raw
            .map((s) => (typeof s === 'string' ? s : ((s as Record<string, unknown>)?.['name'] as string | undefined)))
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [];
      return { ok: true, services, detail: `${services.length} service(s)` };
    } catch {
      const declared = stackConfiguredServices(repo ?? process.cwd());
      if (declared === null) {
        return { ok: false, detail: 'stack status not JSON-parseable and no .stack.toml to read' };
      }
      return {
        ok: true,
        services: declared,
        detail: `${declared.length} service(s) from .stack.toml (stack status not JSON-parseable)`,
      };
    }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// M73: stackRun — thin, bounded passthrough runner
// ---------------------------------------------------------------------------

export interface StackRunResult {
  /** Whether the process exited 0. */
  ok: boolean;
  /** Combined stdout captured (may be empty for streaming calls). */
  stdout: string;
  /** stderr captured (Stack's error messages land here). */
  stderr: string;
  /** Exit code (null when the process couldn't be launched). */
  code: number | null;
}

/**
 * Run `stack <args>` and return {ok, stdout, stderr, code}. Never throws. Bounded by
 * TIMEOUT_MS. Mutating actions (add / apply) MUST be gated by the CLI layer
 * (cmdStack) BEFORE this is called — this runner is intentionally neutral.
 *
 * @param args    Arguments to pass to the `stack` binary (e.g. ['add', 'postgres']).
 * @param opts.cwd  Optional working directory (default: process.cwd()).
 */
export function stackRun(args: string[], opts?: { cwd?: string }): StackRunResult {
  if (!stackInstalled()) {
    return { ok: false, stdout: '', stderr: '', code: null };
  }
  try {
    const res = spawnSync(STACK_BIN, args, {
      cwd: opts?.cwd,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    const stderr = (res.stderr ?? '').trimEnd();
    if (res.error) {
      return { ok: false, stdout: '', stderr: stderr || res.error.message, code: null };
    }
    const stdout = (res.stdout ?? '').trimEnd();
    const code = res.status ?? null;
    return { ok: code === 0, stdout, stderr, code };
  } catch (err) {
    return { ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err), code: null };
  }
}

/**
 * Run a mutating `stack <args>` (add / apply) attached to the operator's
 * terminal: stdio is inherited so Stack can prompt and complete OAuth, bounded
 * by INTERACTIVE_TIMEOUT_MS. The CLI layer MUST confirm before calling this.
 * Never throws.
 */
export function stackRunInteractive(args: string[], opts?: { cwd?: string }): { ok: boolean; code: number | null } {
  if (!stackInstalled()) {
    return { ok: false, code: null };
  }
  try {
    const res = spawnSync(STACK_BIN, args, {
      cwd: opts?.cwd,
      stdio: 'inherit',
      timeout: INTERACTIVE_TIMEOUT_MS,
      env: { ...process.env },
    });
    if (res.error) return { ok: false, code: null };
    const code = res.status ?? null;
    return { ok: code === 0, code };
  } catch {
    return { ok: false, code: null };
  }
}
