/**
 * Screenshots from the desktop operator are local-only by default. Pixels
 * cannot be run through the secret-shape scrubber, so the bytes go to a
 * mode 0600 file under the user state dir and the result carries only the
 * path and metadata. The OCR text still passes through scrubOperatorJson.
 * The image rides in a result only when the caller sets the per-call opt-in
 * (`--include-image` on the CLI, `include_image` on the MCP tool).
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import type { OperatorResult } from './operator.js';

export function screenshotDirectory(): string {
  return join(ashlrHome(), 'desktop-operator', 'shots');
}

export function writeScreenshotFile(bytes: Buffer): string {
  const directory = screenshotDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.png`);
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function deliverScreenshot(
  result: OperatorResult,
  options: { includeImage?: boolean; write?: (bytes: Buffer) => string } = {},
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
  const data: Record<string, unknown> = { ...result.data, bytes: bytes.length, path, imageIncluded: options.includeImage === true };
  if (options.includeImage !== true) delete data['base64'];
  return { ok: true, verb: 'screenshot', data };
}
