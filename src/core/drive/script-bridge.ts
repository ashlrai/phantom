import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { parseDriveSnapshot, type DriveBridge, type DriveReport, type DriveSnapshot } from './supervisor.js';

const execFileAsync = promisify(execFile);
const protocol = 'phm-drive/v1';

/** An operator-owned executable, never a queue-supplied command or shell string. */
export async function checkDriveExecutable(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('Drive executable path must be absolute');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0 || await realpath(path) !== path) {
    throw new Error('Drive executable must be a regular owned executable without writable or linked aliases');
  }
  // A safe leaf is insufficient if another user can replace its parent. Root
  // sticky temporary directories are safe ancestors of an owned private tree.
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const directory = await lstat(parent);
    const trustedOwner = directory.uid === 0 || typeof process.getuid !== 'function' || directory.uid === process.getuid();
    const stickyRoot = directory.uid === 0 && (directory.mode & 0o1000) !== 0;
    if (!directory.isDirectory() || !trustedOwner || ((directory.mode & 0o022) !== 0 && !stickyRoot)) {
      throw new Error('Drive executable has an unsafe parent directory');
    }
    if (dirname(parent) === parent) break;
  }
}

export async function checkDrivePublisher(path: string): Promise<void> {
  if (basename(path) !== 'publish.sh') throw new Error('Drive only publishes through publish.sh');
  await checkDriveExecutable(path);
}

export type DriveCommand = (executable: string, args: string[]) => Promise<string>;

/** Bounded output; child diagnostics can contain credentials and never reach the console. */
export const runDriveCommand: DriveCommand = async (executable, args) => {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      killSignal: 'SIGKILL', windowsHide: true,
    });
    return result.stdout;
  } catch {
    throw new Error('Drive command failed; inspect the private host logs');
  }
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Versioned subprocess seam; no native schema or semaphore path is guessed. */
export class ScriptDriveBridge implements DriveBridge {
  private readonly publications = new Map<string, string[]>();
  constructor(
    readonly executable: string,
    private readonly command: DriveCommand = runDriveCommand,
    private readonly check: (path: string) => Promise<void> = checkDriveExecutable,
  ) {}

  private async call(operation: string, request: Record<string, unknown> = {}): Promise<unknown> {
    await this.check(this.executable);
    let response: unknown;
    try {
      response = JSON.parse(await this.command(this.executable, [operation, JSON.stringify({ protocol, ...request })]));
    } catch { throw new Error(`Drive bridge ${operation} failed`); }
    if (!record(response) || response.protocol !== protocol || !Object.hasOwn(response, 'result')) {
      throw new Error('Invalid drive bridge reply');
    }
    return response.result;
  }
  async snapshot(lease?: string): Promise<DriveSnapshot> {
    return parseDriveSnapshot(await this.call('snapshot', lease ? { lease } : {}));
  }
  async acquire(): Promise<string | null> {
    const result = await this.call('acquire');
    if (result === null) return null;
    if (typeof result !== 'string' || !/^[A-Za-z0-9_-]{16,160}$/.test(result)) throw new Error('Invalid drive ownership lease');
    return result;
  }
  private async acknowledge(operation: string, request: Record<string, unknown>): Promise<void> {
    if (await this.call(operation, request) !== true) throw new Error(`Drive bridge ${operation} was not acknowledged`);
  }
  reap(lease: string): Promise<void> { return this.acknowledge('reap', { lease }); }
  async launch(lease: string, job: string): Promise<'launched' | 'held'> {
    const result = await this.call('launch', { lease, job });
    if (result !== 'launched' && result !== 'held') throw new Error('Invalid drive launch acknowledgement');
    return result;
  }
  async reservePublish(lease: string, job: string): Promise<boolean> {
    const result = await this.call('reserve-publish', { lease, job });
    if (result === null) return false;
    if (!record(result) || !Array.isArray(result.argv) || result.argv.length > 32 ||
        !result.argv.every(arg => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'))) {
      throw new Error('Invalid drive publication reservation');
    }
    this.publications.set(`${lease}/${job}`, result.argv as string[]);
    return true;
  }
  async finishPublish(lease: string, job: string, outcome: 'published' | 'unknown'): Promise<void> {
    this.publications.delete(`${lease}/${job}`);
    await this.acknowledge('finish-publish', { lease, job, outcome });
  }
  writeStatus(lease: string, report: DriveReport): Promise<void> {
    return this.acknowledge('write-status', { lease, report });
  }
  async release(lease: string): Promise<void> {
    for (const key of this.publications.keys()) if (key.startsWith(`${lease}/`)) this.publications.delete(key);
    await this.acknowledge('release', { lease });
  }
  async publish(script: string, job: string, lease: string): Promise<void> {
    const argv = this.publications.get(`${lease}/${job}`);
    if (!argv) throw new Error('Drive publication has no durable reservation');
    // Consume before execution, including failed or timed-out execution.
    this.publications.delete(`${lease}/${job}`);
    if (basename(script) !== 'publish.sh') throw new Error('Drive only publishes through publish.sh');
    await this.check(script);
    await this.command('phantom', ['exec', '--', script, ...argv]);
  }
}
