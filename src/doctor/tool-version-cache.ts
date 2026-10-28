/** Display-only version metadata; no health, authorization or command output is cached. */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFileAtomically } from '../core/util/private-file-write.js';
import { assurePrivateStoragePath } from '../core/util/private-storage.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

const TTL_MS = 60_000;
const MAX_ENTRIES = 128;
const MAX_BYTES = 64 * 1024;
const FILENAME = 'versions.json';
const VERSION = /^\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?(?:\+[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/;
interface Entry { key: string; at: number; version: string }

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && VERSION.test(value);
}

function fingerprint(executable: string, args: readonly string[]): string {
  const real = realpathSync(executable);
  const stat = statSync(real, { bigint: true });
  if (!stat.isFile()) throw new Error('Not a regular executable');
  return createHash('sha256').update(JSON.stringify([
    executable, real, args, process.cwd(), homedir(), process.env.PATH ?? '',
    process.version, process.platform, process.arch,
    ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String),
  ])).digest('hex');
}

/** Refuse redirected or externally writable ancestors rather than repairing them. */
function directory(create: boolean): { root: string; home: string } {
  const home = realpathSync(homedir());
  let root = home;
  for (const component of ['.ashlr', 'cache', 'doctor']) {
    root = join(root, component);
    if (create) {
      try { mkdirSync(root, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid() ||
      process.platform !== 'win32' && (stat.mode & (component === 'doctor' ? 0o077 : 0o022)) !== 0) {
      throw new Error('Unsafe version cache directory');
    }
  }
  if (!assurePrivateStoragePath(root, 'directory', 'inspect-owned', { anchorPath: home }).ok) {
    throw new Error('Unsafe version cache directory');
  }
  return { root, home };
}

function entries(root: string, home: string): Entry[] {
  const file = join(root, FILENAME);
  const result = readStableRegularFile(file, { anchorPath: home, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
  if (!result.ok) return [];
  try {
    const doc = JSON.parse(result.text) as { schemaVersion?: unknown; entries?: unknown };
    if (!doc || doc.schemaVersion !== 1 || !Array.isArray(doc.entries) || doc.entries.length > MAX_ENTRIES) return [];
    const now = Date.now();
    return doc.entries.filter((entry: unknown): entry is Entry => {
      if (!entry || typeof entry !== 'object') return false;
      const row = entry as Entry;
      return Object.keys(row).sort().join(',') === 'at,key,version' &&
        typeof row.key === 'string' && /^[a-f0-9]{64}$/.test(row.key) &&
        Number.isSafeInteger(row.at) && row.at >= 0 && row.at <= now && now - row.at < TTL_MS && validVersion(row.version);
    });
  } catch { return []; }
}

export interface ToolVersionCache {
  read(): string | null;
  write(version: string): void;
}

export interface ToolVersionCacheSession {
  forExecutable(executable: string, args: readonly string[]): ToolVersionCache;
  flush(): void;
}

/** One inventory reads once and publishes once; parallel probes never serialize on durable writes. */
export function createToolVersionCacheSession(): ToolVersionCacheSession {
  const loaded = new Map<string, Entry>();
  const pending = new Map<string, { entry: Entry; unchanged: () => boolean }>();
  let capturedHome: string | null = null;
  try {
    const { root, home } = directory(false);
    capturedHome = home;
    for (const entry of entries(root, home)) loaded.set(entry.key, entry);
  } catch { /* No cache yet, or unsafe cache: all versions will be probed. */ }
  try { capturedHome ??= realpathSync(homedir()); } catch { /* cache disabled */ }
  return {
    forExecutable(executable, args) {
      let key: string | null = null;
      const capturedArgs = [...args];
      try { key = fingerprint(executable, capturedArgs); } catch { /* cache miss */ }
      // Capture before probing: replaced binaries cannot inherit the old probe's version.
      const unchanged = (): boolean => key !== null && fingerprint(executable, capturedArgs) === key;
      return {
        read() {
          try {
            if (!unchanged()) return null;
            const row = loaded.get(key!);
            const now = Date.now();
            return row && row.at <= now && now - row.at < TTL_MS ? row.version : null;
          } catch { return null; }
        },
        write(version) {
          try {
            if (!validVersion(version) || !unchanged()) return;
            const entry = { key: key!, at: Date.now(), version };
            pending.set(key!, { entry, unchanged });
            loaded.set(key!, entry);
          } catch { /* Optional cache must never prevent a fresh probe or diagnosis. */ }
        },
      };
    },
    flush() {
      try {
        if (!pending.size) return;
        const { root, home } = directory(true);
        if (home !== capturedHome) return;
        const file = join(root, FILENAME);
        try {
          const stat = lstatSync(file);
          // Never replace a symlink, hardlink, directory or unsafe existing file.
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
            typeof process.getuid === 'function' && stat.uid !== process.getuid() ||
            process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
        const merged = new Map(entries(root, home).map(entry => [entry.key, entry]));
        for (const { entry, unchanged } of pending.values()) {
          try {
            if (!unchanged() || entry.at > Date.now() || Date.now() - entry.at >= TTL_MS) continue;
            merged.delete(entry.key);
            merged.set(entry.key, entry);
          } catch { /* Changed or removed executable: discard its old version. */ }
        }
        const bytes = JSON.stringify({ schemaVersion: 1, entries: [...merged.values()].slice(-MAX_ENTRIES) });
        if (Buffer.byteLength(bytes) > MAX_BYTES) return;
        writePrivateFileAtomically(join(root, `${randomUUID()}.tmp`), file, bytes, {
          anchorPath: home, label: 'Doctor tool version cache',
        });
      } catch { /* Optional cache must never prevent a fresh probe or diagnosis. */ }
      finally { pending.clear(); }
    },
  };
}
