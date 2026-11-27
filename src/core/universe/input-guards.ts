/** Pure input, path, file-identity and bounded JSON snapshot guards shared across Universe modules and CLIs. */
import type { Stats } from 'node:fs';
import { isAbsolute, parse as parsePath, resolve } from 'node:path';

export interface CanonicalAbsolutePathOptions {
  maxBytes?: number;
  maxLength?: number;
  asciiControlsOnly?: boolean;
  allowRoot?: boolean;
}

export interface BoundedJsonSnapshotOptions {
  maxNodes?: number;
  maxDepth?: number;
  maxArrayLength?: number;
  maxKeyLength?: number;
  maxStringBytes?: number;
  maxTotalStringBytes?: number;
  errorMessage?: string;
}

/** Reject C0, DEL and C1 control characters (optionally allowing tab, LF and CR). */
export function containsControlChars(
  value: string,
  options: { allowWhitespace?: boolean } = {},
): boolean {
  const allowWhitespace = options.allowWhitespace ?? false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 || (code >= 127 && code <= 159)) &&
        !(allowWhitespace && (code === 9 || code === 10 || code === 13))) {
      return true;
    }
  }
  return false;
}

/** Reject ASCII C0 and DEL control characters (optionally allowing tab, LF and CR). */
export function containsAsciiControlChars(
  value: string,
  options: { allowWhitespace?: boolean } = {},
): boolean {
  const allowWhitespace = options.allowWhitespace ?? false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 || code === 127) &&
        !(allowWhitespace && (code === 9 || code === 10 || code === 13))) {
      return true;
    }
  }
  return false;
}

/** Validate a bounded, control-free, canonical absolute path (non-root unless allowRoot is set). */
export function isCanonicalAbsolutePath(
  value: unknown,
  options: CanonicalAbsolutePathOptions = {},
): value is string {
  if (typeof value !== 'string') return false;
  if (!isAbsolute(value) || resolve(value) !== value) return false;
  if (!options.allowRoot && parsePath(value).root === value) return false;
  if (options.maxLength !== undefined) {
    if (value.length > options.maxLength) return false;
  } else if (Buffer.byteLength(value, 'utf8') > (options.maxBytes ?? 4_096)) {
    return false;
  }
  return options.asciiControlsOnly ? !containsAsciiControlChars(value) : !containsControlChars(value);
}

/** Verify two stat snapshots describe the same unchanged regular file. */
export function isSameRegularFile(before: Stats, after: Stats): boolean {
  return after.isFile() && !after.isSymbolicLink() &&
    before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

/** Format an optional shell-quoted `--root` CLI flag for operator guidance strings. */
export function formatUniverseRootFlag(root?: string): string {
  return root ? ` --root '${root.replaceAll("'", "'\\''")}'` : '';
}

/** Detach bounded plain JSON data without invoking accessors, toJSON or custom prototypes. */
export function snapshotBoundedJson<T = unknown>(
  value: unknown,
  options: BoundedJsonSnapshotOptions = {},
): T {
  const maxNodes = options.maxNodes ?? 30_000;
  const maxDepth = options.maxDepth ?? 32;
  const maxArrayLength = options.maxArrayLength ?? 4_096;
  const maxKeyLength = options.maxKeyLength ?? 256;
  const { maxStringBytes, maxTotalStringBytes } = options;
  const errorMessage = options.errorMessage ?? 'Invalid bounded JSON input';
  let nodes = 0;
  let totalStringBytes = 0;
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > maxNodes || depth > maxDepth) throw new Error(errorMessage);
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (typeof item === 'string') {
      const length = Buffer.byteLength(item);
      if (maxStringBytes !== undefined && length > maxStringBytes) throw new Error(errorMessage);
      if (maxTotalStringBytes !== undefined) {
        totalStringBytes += length;
        if (totalStringBytes > maxTotalStringBytes) throw new Error(errorMessage);
      }
      return item;
    }
    if (!item || typeof item !== 'object') throw new Error(errorMessage);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > maxArrayLength ||
          Reflect.ownKeys(item).length !== item.length + 1) throw new Error(errorMessage);
      return Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error(errorMessage);
        return copy(descriptor.value, depth + 1);
      });
    }
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null) throw new Error(errorMessage);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== 'string' || key.length > maxKeyLength || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error(errorMessage);
      }
      output[key] = copy(descriptor.value, depth + 1);
    }
    return output;
  };
  return copy(value, 0) as T;
}
