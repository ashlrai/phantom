import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ingestIMessages } from '../src/core/comms/imessage-inbox-bridge.js';
import { writeCursor, readCursor } from '../src/core/integrations/imessage.js';
import type { AshlrConfig } from '../src/core/types.js';

const runsDir = mkdtempSync(join(tmpdir(), 'patch-recut-'));
afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

it('assembles allowlisted teammate frames locally without forwarding their content', async () => {
  const payload = 'a plainly fake patch\n';
  const digest = createHash('sha256').update(payload).digest('hex');
  const texts = [`PATCH-BEGIN sample 1 ${digest}`, `PATCH-PART sample 1/1\n${payload}`, `PATCH-END sample ${digest}`];
  const cfg = { comms: { enabled: true, imessageHandle: '+1555010001', imessageAllow: ['+1555010001', '+1555010002'] } } as unknown as AshlrConfig;
  writeCursor(1, runsDir);
  const result = await ingestIMessages(cfg, {
    runsDir, platform: 'darwin',
    poll: async () => ({ ok: true, messages: texts.map((text, i) => ({ rowid: i + 2, handle: '+1555010002', text, date: 0 })) }),
  });
  expect(result).toMatchObject({ ok: true, cursor: 4, notMason: 3 });
  expect(readCursor(runsDir)).toBe(4);
  expect(readFileSync(join(runsDir, 'imessage', 'patches', 'sample.patch'), 'utf8')).toBe(payload);
  expect(existsSync(join(runsDir, 'imessage', 'teammates.jsonl'))).toBe(false);
});

it('leaves the cursor before a frame when the transfer ledger is corrupt', async () => {
  const cfg = { comms: { enabled: true, imessageHandle: '+1555010001', imessageAllow: ['+1555010001', '+1555010002'] } } as unknown as AshlrConfig;
  writeCursor(1, runsDir);
  const patches = join(runsDir, 'imessage', 'patches');
  mkdirSync(patches, { recursive: true, mode: 0o700 });
  writeFileSync(join(patches, 'state.json'), 'invalid', { mode: 0o600 });
  const result = await ingestIMessages(cfg, {
    runsDir, platform: 'darwin',
    poll: async () => ({ ok: true, messages: [{ rowid: 2, handle: '+1555010002', text: `PATCH-BEGIN sample 1 ${'a'.repeat(64)}`, date: 0 }] }),
  });
  expect(result).toMatchObject({ ok: false, deferred: true, cursor: 1 });
  expect(readCursor(runsDir)).toBe(1);
  expect(existsSync(join(runsDir, 'imessage', 'teammates.jsonl'))).toBe(false);
});
