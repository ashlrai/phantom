import { dirname, resolve } from 'node:path';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readKnowledgeInputFile(file: string, maxFileBytes: number): ReturnType<typeof readStableRegularFile> {
  const absolute = resolve(file);
  return readStableRegularFile(absolute, {
    anchorPath: dirname(absolute),
    maxFileBytes,
    remainingBytes: maxFileBytes,
  });
}

export type ParsedKnowledgeFileArgs =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; file: string; json: boolean };

export function parseKnowledgeFileArgs(
  args: string[],
  unknownArgMessage: (arg: string | undefined) => string,
): ParsedKnowledgeFileArgs {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { kind: 'help' };
  }
  let file: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--file' && file === undefined) {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('-') || value.includes('\0')) {
        return { kind: 'error', message: '--file requires a path' };
      }
      file = value;
    } else return { kind: 'error', message: unknownArgMessage(arg) };
  }
  if (file === undefined) return { kind: 'error', message: '--file is required' };
  return { kind: 'ok', file, json };
}
