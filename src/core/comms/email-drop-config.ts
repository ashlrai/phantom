import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { readSource } from '../fleet/runs-parked-queue.js';

export const EMAIL_DROP_CONFIG_FILE = join('queue', 'email-drop.json');
const MAX_CONFIG_BYTES = 16 * 1024;

export interface EmailDropConfig {
  v: 1;
  inboxDir: string;
  outboxDir?: string;
  processedDir?: string;
  from: string[];
}

/** Match the email-drop CLI's existing address normalization. */
export function normalizeEmailDropAddress(value: string): string | null {
  const address = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(address) ? address : null;
}

function validConfig(value: unknown): value is EmailDropConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  const directory = (dir: unknown): boolean => typeof dir === 'string' && isAbsolute(dir) && !dir.includes('\0');
  return Object.keys(config).every((key) => ['v', 'inboxDir', 'outboxDir', 'processedDir', 'from'].includes(key)) &&
    config.v === 1 && directory(config.inboxDir) &&
    (config.outboxDir === undefined || directory(config.outboxDir)) &&
    (config.processedDir === undefined || directory(config.processedDir)) &&
    Array.isArray(config.from) && config.from.length >= 1 && config.from.length <= 32 &&
    config.from.every((address: unknown) => typeof address === 'string' &&
      normalizeEmailDropAddress(address) === address &&
      /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(address));
}

export async function readEmailDropConfig(runsDir: string): Promise<{ state: 'missing' | 'invalid' | 'ok'; config?: EmailDropConfig; path: string }> {
  const path = join(runsDir, EMAIL_DROP_CONFIG_FILE);
  try {
    const source = await readSource(path, MAX_CONFIG_BYTES, false);
    if (source.state !== 'healthy') return { state: source.state === 'missing' ? 'missing' : 'invalid', path };
    const config: unknown = JSON.parse(source.text);
    return validConfig(config) ? { state: 'ok', config, path } : { state: 'invalid', path };
  } catch {
    return { state: 'invalid', path };
  }
}

export async function writeEmailDropConfig(runsDir: string, config: EmailDropConfig): Promise<string> {
  if (!validConfig(config)) throw new Error('invalid email-drop config');
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_CONFIG_BYTES) throw new Error('email-drop config too large');
  const path = join(runsDir, EMAIL_DROP_CONFIG_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}
