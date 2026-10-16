import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyPinnedDesktopImage } from '../src/core/run/native-metadata-launch.js';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
function image(bytes: Buffer) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-metadata-image-')));
  roots.push(root);
  const path = join(root, 'desktop-host');
  writeFileSync(path, bytes, { mode: 0o600 });
  return { root, path, stamp: lstatSync(path, { bigint: true }), digest: sha256(bytes) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('early native registration desktop image qualification', () => {
  it('accepts an unchanged pinned image', () => {
    const original = image(Buffer.from('signed-host-image'));
    expect(() => verifyPinnedDesktopImage(original.path, original.stamp, original.digest)).not.toThrow();
  });

  it('rejects same-size byte tamper even when passed the current file stamp', () => {
    const original = image(Buffer.from('signed-host-image'));
    writeFileSync(original.path, Buffer.from('tamper-host-image'));
    const currentStamp = lstatSync(original.path, { bigint: true });
    expect(currentStamp.size).toBe(original.stamp.size);
    expect(() => verifyPinnedDesktopImage(original.path, currentStamp, original.digest)).toThrow('Native desktop image changed');
  });

  it('rejects an old pinned stamp after file replacement', () => {
    const original = image(Buffer.from('signed-host-image'));
    rmSync(original.path);
    writeFileSync(original.path, Buffer.from('signed-host-image'), { mode: 0o600 });
    expect(() => verifyPinnedDesktopImage(original.path, original.stamp, original.digest)).toThrow('Native desktop image changed');
  });

  it('rejects a symbolic link even if its target has the expected bytes', () => {
    const original = image(Buffer.from('signed-host-image'));
    const link = join(original.root, 'host-link');
    symlinkSync(original.path, link);
    expect(() => verifyPinnedDesktopImage(link, lstatSync(link, { bigint: true }), original.digest)).toThrow('Native desktop image changed');
  });
});
