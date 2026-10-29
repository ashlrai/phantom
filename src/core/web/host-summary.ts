/** Read-only machine facts for the chat sidebar. No probes, secrets or writes. */
import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { resolveLlamaRuntimeSettings } from '../local-runtime/llama/config.js';

export const HOST_SUMMARY_PATH = '/api/host';

export interface HostSummary {
  observedAt: string;
  console: { bindHost: string | null; url: string | null; loopback: boolean | null };
  /** Resolved launch setting; this does not claim the inference server is running. */
  localInference: { bindHost: string };
  killSwitch: { state: 'active' | 'inactive' | 'unknown' };
}

interface HostSummaryDependencies {
  lstat?: (path: string) => Promise<Stats>;
}

async function readKillState(inspect: (path: string) => Promise<Stats>): Promise<HostSummary['killSwitch']['state']> {
  try {
    const home = homedir();
    if (!home || !isAbsolute(home)) return 'unknown';
    // Match sandbox/policy.ts's readKillSwitch metadata semantics. Do not
    // follow a symlink or open the sentinel: its presence is the only fact.
    const stat = await inspect(join(resolve(home), '.ashlr', 'KILL'));
    const safe = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
      && (typeof process.getuid !== 'function' || stat.uid === process.getuid())
      && (process.platform === 'win32' || (stat.mode & 0o022) === 0);
    return safe ? 'active' : 'unknown';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' ? 'inactive' : 'unknown';
  }
}

export async function buildHostSummary(
  cfg: AshlrConfig,
  socket: { localAddress?: string; localPort?: number },
  dependencies: HostSummaryDependencies = {},
): Promise<HostSummary> {
  // The socket identifies this listener. Host, Origin and forwarded headers
  // describe the client or proxy and must never supply machine facts.
  const address = socket.localAddress;
  const bindHost = address && isIP(address) ? address : null;
  const port = socket.localPort;
  const validPort = typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535;
  const loopback = bindHost === null ? null
    : bindHost.startsWith('127.') || bindHost === '::1' || bindHost.startsWith('::ffff:127.');
  const url = bindHost !== null && validPort
    ? `http://${isIP(bindHost) === 6 ? `[${bindHost}]` : bindHost}:${port}` : null;
  const killSwitch = { state: await readKillState(dependencies.lstat ?? lstat) };
  return {
    observedAt: new Date().toISOString(),
    console: { bindHost, url, loopback },
    localInference: { bindHost: resolveLlamaRuntimeSettings(cfg).host },
    killSwitch,
  };
}
