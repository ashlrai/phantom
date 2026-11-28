import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** Provider lanes a node may advertise from a native CLI sign-in. */
export const NODE_PROVIDERS = ['codex', 'claude'] as const;
export type NodeProvider = typeof NODE_PROVIDERS[number];
export type ProviderBinaries = Partial<Record<NodeProvider, string>>;

export interface ProviderBinaryDeps {
  home?: string;
  /** The node binary's directory is the default npm-global prefix bin. */
  execPath?: string;
  executable?: (path: string) => boolean;
}

export function isNodeProvider(value: unknown): value is NodeProvider {
  return typeof value === 'string' && (NODE_PROVIDERS as readonly string[]).includes(value);
}

/** Ordered allowlist of absolute install locations. PATH is never consulted. */
export function providerBinaryCandidates(provider: NodeProvider, deps: ProviderBinaryDeps = {}): string[] {
  return isNodeProvider(provider) ? binaryCandidates(provider, deps) : [];
}

/** The same allowlist for any plain CLI name (used by the read-only node doctor).
 * The first group covers macOS and user-level installs; the version-manager and
 * Linux directories appended after the Node prefix resolve only when nothing
 * earlier exists, so an existing resolution never changes. They exist so a
 * contributor node on Linux can find the same provider CLIs. PATH is never
 * consulted. */
export function binaryCandidates(name: string, deps: ProviderBinaryDeps = {}): string[] {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) return [];
  const home = deps.home ?? homedir();
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin',
    ...(isAbsolute(home) ? [join(home, '.local', 'bin'), join(home, '.npm-global', 'bin')] : []),
    dirname(deps.execPath ?? process.execPath),
    ...(isAbsolute(home)
      ? [join(home, '.volta', 'bin'), join(home, '.bun', 'bin'),
        join(home, '.local', 'share', 'mise', 'shims'), join(home, '.asdf', 'shims')]
      : []),
    '/usr/bin', '/bin', '/snap/bin'];
  return [...new Set(dirs.filter(dir => isAbsolute(dir)).map(dir => join(dir, name)))];
}

/** Executable regular file at an allowlisted path; the presence check the
 * installed-CLI probe and resolveProviderBinary share. */
export function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

/** The one absolute binary both the lane probe and the runner execute; null when none is installed. */
export function resolveProviderBinary(provider: NodeProvider, deps: ProviderBinaryDeps = {}): string | null {
  const executable = deps.executable ?? executableFile;
  return providerBinaryCandidates(provider, deps).find(path => executable(path)) ?? null;
}

/**
 * Agent CLIs a community node can advertise as `--caps` that the join
 * sign-in probe does not cover: every cloud-cli harness the capacity
 * measurement knows (src/core/drive/nodes/harness-adapters.ts) except the
 * sign-in-probed providers (codex, claude — their lanes come from
 * probeProviderBinaries) and local-model (its caps come from the
 * local-lanes.json opt-in, never a bare --caps name). `bins` are the CLI
 * binary names binaryCandidates resolves; the cap is the harness id the
 * capacity report and job `--requires` already use. Presence is file
 * existence at an allowlisted path only — installed is not signed in, and
 * nothing is executed or read.
 */
export const COMMUNITY_CLI_CANDIDATES: readonly { cap: string; bins: readonly string[] }[] = Object.freeze([
  { cap: 'aider', bins: ['aider'] },
  { cap: 'aw', bins: ['aw'] },
  { cap: 'ashlrcode', bins: ['ac', 'ashlrcode'] },
  { cap: 'cline', bins: ['cline'] },
  { cap: 'copilot', bins: ['copilot'] },
  { cap: 'cursor', bins: ['cursor-agent'] },
  { cap: 'devin', bins: ['devin'] },
  { cap: 'droid', bins: ['droid'] },
  { cap: 'gemini', bins: ['gemini'] },
  { cap: 'goose', bins: ['goose'] },
  { cap: 'grok', bins: ['grok'] },
  { cap: 'hermes', bins: ['hermes'] },
  { cap: 'opencode', bins: ['opencode'] },
  { cap: 'pi', bins: ['pi'] },
]);

/** Cap names of the community agent CLIs installed on this machine, sorted.
 * File presence at allowlisted paths only: no CLI is executed, no sign-in is
 * checked and no credential is read — a hit means "installed", never "ready". */
export function installedAgentClis(deps: ProviderBinaryDeps = {}): string[] {
  const executable = deps.executable ?? executableFile;
  const found: string[] = [];
  for (const { cap, bins } of COMMUNITY_CLI_CANDIDATES) {
    if (bins.some(bin => binaryCandidates(bin, deps).some(path => executable(path)))) found.push(cap);
  }
  return found;
}
