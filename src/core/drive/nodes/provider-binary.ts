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

/** The same allowlist for any plain CLI name (used by the read-only node doctor). */
export function binaryCandidates(name: string, deps: ProviderBinaryDeps = {}): string[] {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) return [];
  const home = deps.home ?? homedir();
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin',
    ...(isAbsolute(home) ? [join(home, '.local', 'bin'), join(home, '.npm-global', 'bin')] : []),
    dirname(deps.execPath ?? process.execPath)];
  return [...new Set(dirs.filter(dir => isAbsolute(dir)).map(dir => join(dir, name)))];
}

function executableFile(path: string): boolean {
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
