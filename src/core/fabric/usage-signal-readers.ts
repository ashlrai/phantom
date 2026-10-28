import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { USAGE_POOLS, type UsagePool } from './usage-signal-writer.js';

export type UsageReaderCommands = Partial<Record<UsagePool, string>>;

/** Operator-provisioned read-only executables, with no arguments or inline credentials. */
export function usageReaderCommands(value: unknown): UsageReaderCommands {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid usage reader configuration');
  const commands: UsageReaderCommands = {};
  for (const [pool, command] of Object.entries(value)) {
    if (!USAGE_POOLS.includes(pool as UsagePool) || typeof command !== 'string' ||
      !isAbsolute(command) || command.length > 4096 || /[\r\n\0]/.test(command)) {
      throw new Error('Invalid usage reader configuration');
    }
    commands[pool as UsagePool] = command;
  }
  return commands;
}

/** Each invocation stays behind the Secrets proxy. No raw stderr or provider errors escape. */
export function usageSignalReaders(commands: UsageReaderCommands): Partial<Record<UsagePool, () => Promise<unknown>>> {
  const configured = usageReaderCommands(commands);
  const readers: Partial<Record<UsagePool, () => Promise<unknown>>> = {};
  for (const pool of USAGE_POOLS) {
    const command = configured[pool];
    if (!command) continue;
    readers[pool] = () => new Promise(resolve => {
      const env: NodeJS.ProcessEnv = {};
      // Do not inherit provider keys or tokens. Phantom Secrets owns any key resolution.
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      execFile('phantom', ['exec', '--', command], { env, shell: false, timeout: 15_000,
        killSignal: 'SIGKILL', maxBuffer: 8192, encoding: 'utf8' }, (error, stdout) => {
        if (error) { resolve(null); return; }
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
    });
  }
  return readers;
}
