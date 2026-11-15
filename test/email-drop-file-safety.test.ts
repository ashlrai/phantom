import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMAIL_DROP_MAX_BYTES, runEmailDropOnce } from '../src/core/comms/email-drop-bridge.js';

const root = mkdtempSync(join(tmpdir(), 'email-drop-safety-'));
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('rejects symlinks, oversized files and non-regular files without stopping the pass', async () => {
  const inboxDir = join(root, 'inbox');
  const outboxDir = join(root, 'outbox');
  const processedDir = join(root, 'processed');
  for (const dir of [inboxDir, outboxDir, processedDir]) mkdirSync(dir);
  const target = join(root, 'target');
  writeFileSync(target, 'From: denied@example.com\n\nbody');
  symlinkSync(target, join(inboxDir, 'link.eml'));
  writeFileSync(join(inboxDir, 'large.eml'), Buffer.alloc(EMAIL_DROP_MAX_BYTES + 1));
  mkdirSync(join(inboxDir, 'directory.eml'));
  writeFileSync(join(inboxDir, 'valid.eml'), 'From: denied@example.com\n\nbody');
  const result = await runEmailDropOnce({ inboxDir, outboxDir, processedDir, runsDir: root, allowedSenders: new Set() });
  expect(result).toMatchObject({ refused: 1, failed: 3 });
  expect(readdirSync(processedDir)).toEqual(['valid.eml']);
  expect(readdirSync(inboxDir).sort()).toEqual(['directory.eml', 'large.eml', 'link.eml']);
});
