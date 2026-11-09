import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function preparedArchiveFixture(t, prefix = 'dist') {
  const root = mkdtempSync(join(tmpdir(), 'release-dist-test-'));
  const prepared = mkdtempSync(join(tmpdir(), 'release-input-test-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(prepared, { recursive: true, force: true }); });
  const content = Buffer.from('original build bytes');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const entries = [{ path: prefix, type: 'directory', mode: 0o755 },
    { path: `${prefix}/worker.js`, type: 'file', mode: 0o755, bytes: content.length, sha256: hash(content) },
    { path: `${prefix}/inventory.json`, type: 'file', mode: 0o400, bytes: content.length, sha256: hash(content) }];
  const parts = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;
    header.write(entry.path, 0); header.write(octal(entry.mode, 8), 100);
    header.write(octal(0, 8), 108); header.write(octal(0, 8), 116);
    header.write(octal(entry.bytes ?? 0, 12), 124); header.write(octal(0, 12), 136);
    header.fill(32, 148, 156); header[156] = entry.type === 'directory' ? 53 : 48;
    header.write('ustar\0', 257); header.write('00', 263);
    header.write(`${header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(header);
    if (entry.type === 'file') parts.push(content, Buffer.alloc(512 - content.length));
  }
  const bytes = Buffer.concat([...parts, Buffer.alloc(1024)]);
  writeFileSync(join(prepared, 'dist.tar'), bytes);
  return { root, prepared, manifest: { archive: { bytes: bytes.length, sha256: hash(bytes), entries } }, bytes, content };
}
