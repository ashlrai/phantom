/**
 * The launch agent — what makes "24/7" true rather than aspirational.
 *
 * A supervised process that dies with its terminal is not a service. launchd
 * is macOS's answer: `RunAtLoad` starts the runtime at login and `KeepAlive`
 * restarts it if it crashes or is killed, without anything of ours having to
 * be running to notice.
 *
 * ## This writes OUTSIDE the repository
 *
 * The plist lands in `~/Library/LaunchAgents/`, which is the machine's login
 * configuration, not project state. That is a different kind of change from
 * anything else this codebase does, so:
 *
 *   * it happens ONLY behind an explicit `--install` flag, never as a side
 *     effect of `start`;
 *   * the absolute plist path is printed to the operator every time; and
 *   * `local-runtime uninstall` removes it completely, so the change is
 *     reversible by the same tool that made it.
 *
 * It is also refused while `~/.ashlr/KILL` is engaged. Installing a job that
 * brings a serving runtime up at every login is exactly the standing
 * authority that switch exists to withhold; the caller performs that check
 * (see src/cli/local-runtime.ts) and this module never reads, creates or
 * removes the sentinel itself.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MISSING_MODEL_BACKOFF_MS, missingModelStatePath } from '../missing-model-guard.js';
import {
  LAUNCH_AGENT_LABEL,
  launchAgentPlistPath,
  launchAgentShimPath,
  localRuntimeDir,
  logsDir,
  stderrLogPath,
  stdoutLogPath,
} from './paths.js';

/** Escape a string for an XML text node. Paths may legitimately contain `&`. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Everything the plist needs. Kept explicit so generation stays pure. */
export interface LaunchAgentSpec {
  /** Absolute llama-server path. */
  binPath: string;
  /** argv after argv[0]. */
  args: string[];
  stdoutLog: string;
  stderrLog: string;
  /** Working directory for the job. */
  workingDirectory: string;
  /**
   * The Ollama model reference the `-m` blob path was resolved FROM, when it
   * was. Null when the operator supplied an explicit `modelPath` — that path is
   * their own choice and must never be second-guessed at launch.
   */
  modelRef?: string | null;
  /**
   * argv of a command that prints the current absolute blob path for
   * {@link LaunchAgentSpec.modelRef} on stdout and exits 0, e.g.
   * `['/usr/local/bin/ashlr', 'local-runtime', 'resolve-model']`. Null disables
   * re-resolution and the frozen path is used verbatim.
   */
  resolverCommand?: readonly string[] | null;
  /**
   * argv that re-enters this hub as `local-runtime missing-model-guard` — the
   * one blocked state the shim hands an unresolvable miss to, e.g.
   * `['/usr/local/bin/ashlr', 'local-runtime', 'missing-model-guard']`. Passed
   * even when {@link LaunchAgentSpec.resolverCommand} is null: an explicit
   * modelPath can go missing too, and the job must still not spin. Null
   * degrades the shim to an inline `sleep`+`exit` that still holds the
   * backoff window rather than exec'ing a path that does not exist.
   */
  guardCommand?: readonly string[] | null;
}

/**
 * Single-quote a string for POSIX sh. Safe for every byte but NUL.
 *
 * An embedded quote closes the literal, emits an escaped quote, and reopens
 * it — the only portable way, since sh has no escapes inside single quotes.
 */
export function shQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/**
 * Render the launcher shim the launch agent actually executes.
 *
 * ── WHY A SHIM AND NOT `llama-server` DIRECTLY ────────────────────────────
 *
 * Ollama's model store is CONTENT-ADDRESSED. The GGUF we serve lives at
 * `~/.ollama/models/blobs/sha256-<digest>`, and that digest changes whenever
 * the tag is re-pulled or retagged — at which point the old blob is garbage
 * collected. A plist that froze the digest at install time would then point at
 * a file that no longer exists, and launchd's unconditional `KeepAlive` with
 * `ThrottleInterval 10` would respawn llama-server against it every ten
 * seconds, forever, while every hub surface reported only `state: 'down'`.
 * That is a permanently dead 24/7 runtime produced by a routine `ollama pull`.
 *
 * So the shim re-checks at every launch: use the frozen path when it is still
 * there (the fast, offline, no-dependency case), otherwise ask the hub to
 * re-resolve the reference from the manifest. And when the blob is gone for
 * good — `~/.ollama` recreated empty, the reference unresolvable — the attempt
 * is handed to the missing-model guard instead of `exec`: it stamps the
 * failure in `~/.ashlr/local-runtime/missing-model.json`, prints one line
 * naming the model and `ashlr local-runtime install`, and holds the attempt
 * inside the backoff window before exiting nonzero, so launchd restarts into
 * `retry-after` rather than respawning llama-server against a path that does
 * not exist. A missing model is one blocked state, not a ten-second restart
 * loop — the Nov 1 incident burned process starts on a machine already at
 * load 126. See ../missing-model-guard.ts.
 *
 * `exec` replaces the shell, so launchd supervises llama-server's OWN pid.
 * Nothing here is interpolated unquoted: every path goes through
 * {@link shQuote}.
 *
 * PURE — string in, string out — so the exact script is pinned by unit tests.
 */
export function buildLaunchAgentShim(spec: LaunchAgentSpec): string {
  const modelFlagAt = spec.args.indexOf('-m');
  const frozen = modelFlagAt >= 0 ? spec.args[modelFlagAt + 1] ?? '' : '';
  const rest = spec.args.filter(
    (_, index) => modelFlagAt < 0 || (index !== modelFlagAt && index !== modelFlagAt + 1),
  );

  const canReResolve =
    spec.resolverCommand !== null &&
    spec.resolverCommand !== undefined &&
    spec.resolverCommand.length > 0 &&
    typeof spec.modelRef === 'string' &&
    spec.modelRef.length > 0;

  // The model reference reaches the script as a shell VARIABLE rather than
  // being interpolated into a double-quoted string, so a reference containing
  // `$`, a backtick or a quote can never become shell syntax. The guard argv
  // gets the same treatment for the same reason.
  const guardArgv =
    spec.guardCommand !== null &&
    spec.guardCommand !== undefined &&
    spec.guardCommand.length > 0
      ? spec.guardCommand.map(shQuote).join(' ')
      : null;

  // What the attempt does when the model is absent and stays absent this
  // launch: hand it to the missing-model guard (`|| exit 1` — a `run` exit
  // falls through to exec), or — without a guard argv — hold the backoff
  // window inline so KeepAlive still cannot spin on the missing file. The
  // fallback line names the same model variable the shim already defined;
  // nothing unquoted is ever interpolated.
  const backoffSeconds = Math.ceil(MISSING_MODEL_BACKOFF_MS / 1000);
  const guardBlock = (modelExpr: string | null, varName: 'REF' | 'MODEL'): string =>
    guardArgv !== null
      ? `${guardArgv} --model-path "$MODEL"${modelExpr === null ? '' : ` --model ${modelExpr}`} || exit 1`
      : `echo "[ashlr local-runtime] model $${varName} is missing and could not be re-resolved — fix: ashlr local-runtime install" >&2; sleep ${backoffSeconds}; exit 1`;

  const resolveBlock = canReResolve
    ? `REF=${shQuote(spec.modelRef as string)}
  RESOLVED="$(${(spec.resolverCommand as readonly string[]).map(shQuote).join(' ')} --model "$REF" 2>/dev/null || true)"
  if [ -n "$RESOLVED" ] && [ -f "$RESOLVED" ]; then
    echo "[ashlr local-runtime] model blob moved; re-resolved $REF -> $RESOLVED" >&2
    MODEL="$RESOLVED"
  else
    ${guardBlock('"$REF"', 'REF')}
  fi`
    : guardBlock(
        typeof spec.modelRef === 'string' && spec.modelRef.length > 0
          ? shQuote(spec.modelRef)
          : null,
        'MODEL',
      );

  return `#!/bin/sh
# Generated by \`ashlr local-runtime install\`. Do not edit — reinstall instead.
# Removed by \`ashlr local-runtime uninstall\`.
set -u

MODEL=${shQuote(frozen)}

if [ ! -f "$MODEL" ]; then
  ${resolveBlock}
fi

exec ${shQuote(spec.binPath)} -m "$MODEL"${rest.length > 0 ? ` ${rest.map(shQuote).join(' ')}` : ''}
`;
}

/** Fields shared by every KeepAlive shim-backed launch agent plist in this family. */
export interface LaunchAgentPlistFields {
  label: string;
  shimPath: string;
  workingDirectory: string;
  stdoutLog: string;
  stderrLog: string;
}

/**
 * Render a KeepAlive background launch agent plist executing `/bin/sh <shimPath>`.
 *
 * PURE — no filesystem, no launchctl — so the exact XML is pinned by unit
 * tests. `KeepAlive` is unconditional rather than `SuccessfulExit: false`:
 * the point of this job is that the runtime is ALWAYS up, so a clean exit is
 * just as much a reason to restart as a crash. `ProcessType: Background` keeps
 * macOS from treating a long-running inference process as a misbehaving
 * foreground app and throttling it.
 */
export function renderLaunchAgentPlist(fields: LaunchAgentPlistFields): string {
  const programArguments = ['/bin/sh', fields.shimPath]
    .map((arg) => `      <string>${escapeXml(arg)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(fields.label)}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>WorkingDirectory</key>
    <string>${escapeXml(fields.workingDirectory)}</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(fields.stdoutLog)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(fields.stderrLog)}</string>
  </dict>
</plist>
`;
}

export function buildLaunchAgentPlist(
  spec: LaunchAgentSpec,
  shimPath: string = launchAgentShimPath(),
): string {
  return renderLaunchAgentPlist({
    label: LAUNCH_AGENT_LABEL,
    shimPath,
    workingDirectory: spec.workingDirectory,
    stdoutLog: spec.stdoutLog,
    stderrLog: spec.stderrLog,
  });
}

/** Is a plist present at `path`? Never throws. */
export function isLaunchAgentInstalled(path: string): boolean {
  try { return existsSync(path); } catch { return false; }
}

/** Is our plist present in ~/Library/LaunchAgents? Never throws. */
export function launchAgentInstalled(path = launchAgentPlistPath()): boolean {
  return isLaunchAgentInstalled(path);
}

/** `gui/<uid>` — the per-user launchd domain. */
function guiDomain(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return `gui/${uid}`;
}

/** Run launchctl, returning stdout, or null on any failure. Never throws. */
function launchctl(args: string[]): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('/bin/launchctl', args, {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/** Is the named job currently bootstrapped into launchd? */
export function isLaunchAgentLoaded(label: string): boolean {
  if (process.platform !== 'darwin') return false;
  return launchctl(['print', `${guiDomain()}/${label}`]) !== null;
}

/** Is the job currently bootstrapped into launchd? */
export function launchAgentLoaded(): boolean {
  return isLaunchAgentLoaded(LAUNCH_AGENT_LABEL);
}

/** Result of an install/uninstall attempt. Never a thrown error. */
export interface LaunchAgentMutation {
  ok: boolean;
  /** Absolute plist path — always reported, so the operator can see and audit it. */
  plistPath: string;
  /** Whether launchd accepted the bootstrap/bootout. */
  loaded: boolean;
  detail: string;
}

export interface ManagedLaunchAgentInstall {
  label: string;
  plistPath: string;
  shimPath: string;
  shimContent: string;
  plistContent: string;
  subject: string;
  loadedDetail: string;
  onAfterWrite?: () => void;
}

/** Write a shim-backed launch agent plist and bootstrap it into launchd. Never throws. */
export function installManagedLaunchAgent(opts: ManagedLaunchAgentInstall): LaunchAgentMutation {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      plistPath: opts.plistPath,
      loaded: false,
      detail: 'launch agents are a macOS facility; this platform has no equivalent here',
    };
  }
  try {
    mkdirSync(dirname(opts.plistPath), { recursive: true });
    mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
    mkdirSync(localRuntimeDir(), { recursive: true, mode: 0o700 });
    // Owner-only: the shim names an absolute binary and `exec`s it at every login.
    writeFileSync(opts.shimPath, opts.shimContent, { mode: 0o700 });
    writeFileSync(opts.plistPath, opts.plistContent, { mode: 0o644 });
    opts.onAfterWrite?.();
  } catch (err: unknown) {
    return {
      ok: false,
      plistPath: opts.plistPath,
      loaded: false,
      detail: `could not write the ${opts.subject}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const domain = guiDomain();
  launchctl(['bootout', `${domain}/${opts.label}`]);
  const bootstrapped = launchctl(['bootstrap', domain, opts.plistPath]) !== null;
  if (bootstrapped) launchctl(['enable', `${domain}/${opts.label}`]);
  const loaded = bootstrapped && isLaunchAgentLoaded(opts.label);
  return {
    ok: true,
    plistPath: opts.plistPath,
    loaded,
    detail: loaded
      ? opts.loadedDetail
      : `${opts.subject} written, but launchctl did not bootstrap it — it will still load at next login`,
  };
}

export interface ManagedLaunchAgentUninstall {
  label: string;
  plistPath: string;
  cleanupPaths: readonly string[];
  subject: string;
  removeErrorTarget: string;
}

/** Boot a managed launch agent out and remove its plist and shim files. Never throws. */
export function uninstallManagedLaunchAgent(opts: ManagedLaunchAgentUninstall): LaunchAgentMutation {
  const wasInstalled = isLaunchAgentInstalled(opts.plistPath);
  launchctl(['bootout', `${guiDomain()}/${opts.label}`]);
  try {
    rmSync(opts.plistPath, { force: true });
    for (const file of opts.cleanupPaths) rmSync(file, { force: true });
  } catch (err: unknown) {
    return {
      ok: false,
      plistPath: opts.plistPath,
      loaded: isLaunchAgentLoaded(opts.label),
      detail: `could not remove the ${opts.removeErrorTarget}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    ok: true,
    plistPath: opts.plistPath,
    loaded: false,
    detail: wasInstalled
      ? `${opts.subject} booted out and removed`
      : `no ${opts.subject} was installed; nothing to remove`,
  };
}

/** Write the plist and bootstrap the llama-server launch agent. */
export function installLaunchAgent(spec: LaunchAgentSpec): LaunchAgentMutation {
  const plistPath = launchAgentPlistPath();
  const shimPath = launchAgentShimPath();
  return installManagedLaunchAgent({
    label: LAUNCH_AGENT_LABEL,
    plistPath,
    shimPath,
    shimContent: buildLaunchAgentShim(spec),
    plistContent: buildLaunchAgentPlist(spec, shimPath),
    subject: 'launch agent',
    loadedDetail:
      'launch agent written and bootstrapped; the runtime now starts at login and restarts on crash',
    onAfterWrite: () => rmSync(missingModelStatePath(), { force: true }),
  });
}

/** Boot the job out and delete the plist. Idempotent; never throws. */
export function uninstallLaunchAgent(): LaunchAgentMutation {
  return uninstallManagedLaunchAgent({
    label: LAUNCH_AGENT_LABEL,
    plistPath: launchAgentPlistPath(),
    cleanupPaths: [launchAgentShimPath(), missingModelStatePath()],
    subject: 'launch agent',
    removeErrorTarget: 'plist',
  });
}

/** Stop a loaded job without removing its plist, so `stop` can free the port. */
export function bootoutLaunchAgent(): boolean {
  if (!launchAgentLoaded()) return false;
  launchctl(['bootout', `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]);
  return !launchAgentLoaded();
}

/** Default log paths, re-exported so callers do not reach into paths.ts. */
export function launchAgentLogPaths(): { stdout: string; stderr: string } {
  return { stdout: stdoutLogPath(), stderr: stderrLogPath() };
}
