/**
 * Screenshots from the desktop operator are local-only. Pixels
 * cannot be run through the secret-shape scrubber, so the bytes go to a
 * mode 0600 file under the user state dir and the result carries only the
 * path and metadata. The OCR text still passes through scrubOperatorJson.
 */
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import type { OperatorResult } from './operator.js';

export function screenshotDirectory(): string {
  return join(ashlrHome(), 'desktop-operator', 'shots');
}

export function writeScreenshotFile(bytes: Buffer): string {
  const directory = screenshotDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
    throw new Error('unsafe screenshot directory');
  }
  const now = Date.now();
  const shots = readdirSync(directory).filter((name) => /^[0-9a-f-]{36}\.png$/.test(name)).map((name) => {
    const path = join(directory, name);
    return { path, stat: lstatSync(path) };
  }).filter((shot) => shot.stat.isFile()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  for (const [index, shot] of shots.entries()) {
    if (index >= 99 || now - shot.stat.mtimeMs > 7 * 24 * 60 * 60 * 1000) unlinkSync(shot.path);
  }
  const path = join(directory, `${randomUUID()}.png`);
  writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  return path;
}

export function deliverScreenshot(
  result: OperatorResult,
  options: { write?: (bytes: Buffer) => string } = {},
): OperatorResult {
  if (!result.ok || result.verb !== 'screenshot' || typeof result.data['base64'] !== 'string') return result;
  const bytes = Buffer.from(result.data['base64'], 'base64');
  let path: string;
  try {
    path = (options.write ?? writeScreenshotFile)(bytes);
  } catch {
    // Never fall back to returning the image when local storage fails.
    return { ok: false, verb: 'screenshot', code: 'failed', error: 'screenshot could not be stored locally' };
  }
  const data: Record<string, unknown> = { ...result.data, bytes: bytes.length, path };
  delete data['base64'];
  return { ok: true, verb: 'screenshot', data };
}
