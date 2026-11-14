/**
 * core/fleet/runtime-identity.ts: sanitized, read-only evidence of which host
 * and build is answering, and how fresh its fleet-state read is. Backs
 * `ashlr fleet runtime-identity [--json]`.
 *
 * Every dependency is injected so tests never touch the real host. A field that
 * cannot be read is the string "unknown" plus a `reasons[]` entry; nothing is
 * guessed. Output is sanitized: the home directory becomes `~`, IPv4/IPv6
 * addresses are dropped, and no environment value is ever read.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInstalledBundleVersion } from '../app-update-status.js';
import { defaultStatePath } from './main-red-age.js';

export const UNKNOWN = 'unknown';
/** Fleet state older than this is reported stale. */
export const STALE_AFTER_SECONDS = 15 * 60;

export interface RuntimeIdentityDeps {
  hostname(): string;
  platform(): string;
  now(): Date;
  /** Home directory, used only to redact it from output. */
  homeDir(): string;
  /** The fleet state file the fleet already reads (guardian/state.json). */
  statePath(): string;
  /** mtime in ms since epoch; throws when the file cannot be stat'd. */
  statMtimeMs(path: string): number;
  /** Raw text of the running module's package.json; throws when unreadable. */
  readSourcePackageJson(): string;
  /** Version of the installed app bundle, or null when not installed or unreadable. */
  installedVersion(): string | null;
  /** Runs a binary with fixed args and returns stdout; throws when missing or failing. */
  exec(cmd: string, args: readonly string[]): string;
}

export interface FleetStateIdentity {
  path: string;
  mtime: string;
  ageSeconds: number | 'unknown';
  stale: boolean | 'unknown';
}

export interface RuntimeIdentity {
  host: string;
  platform: string;
  asOf: string;
  installedVersion: string;
  sourceVersion: string;
  versionDrift: boolean;
  fleetState: FleetStateIdentity;
  tailnetName: string;
  reasons: string[];
}

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;

/** Redact the home path and any IP address from a string headed for output. */
export function sanitizeIdentityText(value: string, home: string): string {
  let out = value;
  if (home && home !== '/') out = out.split(home).join('~');
  return out.replace(IPV4, '[ip]').replace(IPV6, '[ip]');
}

function clean(value: unknown, home: string): string | null {
  if (typeof value !== 'string') return null;
  const text = sanitizeIdentityText(value.trim(), home).slice(0, 200);
  return text === '' ? null : text;
}

export function readRuntimeIdentity(deps: RuntimeIdentityDeps): RuntimeIdentity {
  const reasons: string[] = [];
  const home = (() => { try { return deps.homeDir(); } catch { return ''; } })();
  const now = deps.now();

  let host = UNKNOWN;
  try {
    host = clean(deps.hostname(), home) ?? UNKNOWN;
  } catch { /* falls through to the reason below */ }
  if (host === UNKNOWN) reasons.push('host: hostname unavailable');

  let plat = UNKNOWN;
  try { plat = clean(deps.platform(), home) ?? UNKNOWN; } catch { /* reason below */ }
  if (plat === UNKNOWN) reasons.push('platform: unavailable');

  let installed = UNKNOWN;
  try { installed = clean(deps.installedVersion(), home) ?? UNKNOWN; } catch { /* reason below */ }
  if (installed === UNKNOWN) reasons.push('installedVersion: no installed app bundle version readable');

  let source = UNKNOWN;
  try {
    const parsed = JSON.parse(deps.readSourcePackageJson()) as { version?: unknown };
    source = clean(parsed.version, home) ?? UNKNOWN;
  } catch { /* reason below */ }
  if (source === UNKNOWN) reasons.push('sourceVersion: package.json version unreadable');

  const versionDrift = installed !== UNKNOWN && source !== UNKNOWN && installed !== source;

  let statePath = UNKNOWN;
  try { statePath = clean(deps.statePath(), home) ?? UNKNOWN; } catch { /* reason below */ }
  const fleetState: FleetStateIdentity = { path: statePath, mtime: UNKNOWN, ageSeconds: UNKNOWN, stale: UNKNOWN };
  try {
    // Stat the real path; only the reported copy is redacted.
    const mtimeMs = deps.statMtimeMs(deps.statePath());
    if (!Number.isFinite(mtimeMs)) throw new Error('bad mtime');
    const age = Math.max(0, Math.floor((now.getTime() - mtimeMs) / 1000));
    fleetState.mtime = new Date(mtimeMs).toISOString();
    fleetState.ageSeconds = age;
    fleetState.stale = age > STALE_AFTER_SECONDS;
  } catch {
    reasons.push('fleetState: state file missing or unreadable');
  }

  let tailnetName = UNKNOWN;
  try {
    const status = JSON.parse(deps.exec('tailscale', ['status', '--json'])) as { Self?: { HostName?: unknown } };
    tailnetName = clean(status.Self?.HostName, home) ?? UNKNOWN;
    if (tailnetName === UNKNOWN) reasons.push('tailnetName: tailscale status has no Self.HostName');
  } catch {
    reasons.push('tailnetName: tailscale unavailable or status unreadable');
  }

  return {
    host, platform: plat, asOf: now.toISOString(),
    installedVersion: installed, sourceVersion: source, versionDrift,
    fleetState, tailnetName, reasons,
  };
}

/** Live dependencies: read-only stat/read plus `tailscale status --json` only. */
export function defaultRuntimeIdentityDeps(): RuntimeIdentityDeps {
  return {
    hostname: () => hostname(),
    platform: () => platform(),
    now: () => new Date(),
    homeDir: () => homedir(),
    statePath: () => defaultStatePath(),
    statMtimeMs: path => statSync(path).mtimeMs,
    // src/core/fleet and dist/core/fleet both sit three levels under the package root.
    readSourcePackageJson: () => readFileSync(join(fileURLToPath(new URL('../../../', import.meta.url)), 'package.json'), 'utf8'),
    installedVersion: readInstalledBundleVersion,
    exec: (cmd, args) => execFileSync(cmd, [...args], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }),
  };
}
