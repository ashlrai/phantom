/**
 * Signer/daemon binding and the single-install plist target.
 *
 * A grant binds the authority-surface digest of the release the resident
 * daemon plist executes. A drafting CLI whose own compiled digest differs
 * is refused. The installer writes that plist at the `current` release
 * pointer instead of a hashed releases directory.
 */
import { dirname } from 'node:path';

export interface SignerDaemonInput {
  cliDigest: string | null;
  daemonDigest: string | null;
  fallbackDigest: string | null;
}

export type SignerDaemonJudgement =
  | { ok: true; digest: string; cliDigest: string | null; daemonDigest: string | null }
  | {
      ok: false;
      code: 'signer-daemon-mismatch' | 'surface-unverified';
      reason: string;
      cliDigest: string | null;
      daemonDigest: string | null;
    };

/** Refuse when the drafting CLI and the daemon release are different compiled digests. */
export function judgeSignerDaemon(input: SignerDaemonInput): SignerDaemonJudgement {
  const { cliDigest, daemonDigest, fallbackDigest } = input;
  if (cliDigest && daemonDigest && cliDigest !== daemonDigest) {
    return {
      ok: false,
      code: 'signer-daemon-mismatch',
      cliDigest,
      daemonDigest,
      reason: `signer-daemon-mismatch: drafting CLI digest ${cliDigest} does not match the daemon release digest ${daemonDigest}`,
    };
  }
  const digest = daemonDigest ?? fallbackDigest;
  if (!digest) {
    return {
      ok: false,
      code: 'surface-unverified',
      cliDigest,
      daemonDigest,
      reason: 'The authority code of the daemon release could not be verified.',
    };
  }
  return { ok: true, digest, cliDigest, daemonDigest };
}

/** ProgramArguments string values, or null when the plist has no argument array. */
export function plistProgramArguments(xml: string): string[] | null {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(xml)?.[1];
  if (!array) return null;
  return [...array.matchAll(/<string>([^<]*)<\/string>/gu)].map((match) => match[1]!);
}

/** Package root of a daemon argv whose script is bin/ashlr or bin/phm. */
export function packageRootFromDaemonArguments(args: readonly string[]): string | null {
  for (const arg of args) {
    if (arg.endsWith('/bin/ashlr') || arg.endsWith('/bin/phm')) return dirname(dirname(arg));
  }
  return null;
}

export function daemonPackageRootFromPlist(xml: string): string | null {
  const args = plistProgramArguments(xml);
  return args ? packageRootFromDaemonArguments(args) : null;
}

/**
 * The current-pointer path for a hashed release entrypoint, using the home
 * embedded in that path. A path outside the releases directory is unchanged.
 */
export function rewriteDaemonEntrypoint(entrypoint: string): string {
  const marker = '/.local/share/ashlr/releases/';
  const at = entrypoint.indexOf(marker);
  if (at < 0) return entrypoint;
  return rewriteReleasePathToCurrent(entrypoint, entrypoint.slice(0, at));
}

/**
 * Point a releases/<id>/... path at the current release pointer.
 * Any other path is unchanged, and a current path stays a current path.
 */
export function rewriteReleasePathToCurrent(path: string, home: string): string {
  const root = home.endsWith('/') ? home.slice(0, -1) : home;
  const prefix = `${root}/.local/share/ashlr/releases/`;
  if (!path.startsWith(prefix)) return path;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return path;
  const id = rest.slice(0, slash);
  if (!/^[A-Za-z0-9._-]+$/u.test(id)) return path;
  return `${root}/.local/share/ashlr/current${rest.slice(slash)}`;
}

/** Rewrite every ProgramArguments string that names a hashed release directory. */
export function rewriteDaemonPlistToCurrent(xml: string, home: string): string {
  return xml.replace(/<string>([^<]*)<\/string>/gu, (whole, value: string) => {
    const next = rewriteReleasePathToCurrent(value, home);
    return next === value ? whole : `<string>${next}</string>`;
  });
}

export interface PathCopy {
  name: 'phm' | 'ashlr';
  /** Real path of the executable, or null when that name is absent. */
  target: string | null;
}

/** Ready only while every resolved phm and ashlr on PATH is the same release. */
export function pathCopiesReady(copies: readonly PathCopy[]): { ready: boolean; reason: string } {
  const releases = [...new Set(copies.map((copy) => copy.target).filter((target): target is string => target !== null && target.length > 0))];
  if (releases.length <= 1) {
    return { ready: true, reason: releases.length === 0 ? 'No extra phm copies on PATH.' : 'PATH phm copies are one release.' };
  }
  return { ready: false, reason: 'More than one phm on PATH resolves to a different release.' };
}
