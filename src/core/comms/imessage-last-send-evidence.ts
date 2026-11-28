import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { imessageStateDir } from '../integrations/imessage.js';

export type LastSendEvidence =
  | { sourceState: 'missing' | 'unreadable' }
  | { sourceState: 'ok'; ok: boolean; at: string };

/** Read the writer's small receipt without following links or exposing its contents. */
export function readImessageLastSendEvidence(runsDir?: string): LastSendEvidence {
  const unreadable: LastSendEvidence = { sourceState: 'unreadable' };
  let fd: number;
  try {
    fd = openSync(join(imessageStateDir(runsDir), 'last-send.json'),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { sourceState: 'missing' } : unreadable;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) return unreadable;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) return unreadable;
      offset += count;
    }
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unreadable;
    const receipt = value as Record<string, unknown>;
    if (receipt.version !== 1 || typeof receipt.ok !== 'boolean' || typeof receipt.at !== 'string'
      || (receipt.ok && !Number.isFinite(Date.parse(receipt.at)))) return unreadable;
    return { sourceState: 'ok', ok: receipt.ok, at: receipt.at };
  } catch { return unreadable; } finally { closeSync(fd); }
}
