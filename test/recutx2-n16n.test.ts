import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUnifiedInbox } from '../src/core/comms/unified-inbox.js';

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
it.each(['original', 'flat'])('recutx2: a malformed %s duplicate cannot hide a valid exporter message', async shape => {
  root = mkdtempSync(join(tmpdir(), 'recutx2-'));
  const base = join(root, 'comms', 'linkedin'), inbox = join(base, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const valid = { id: 'fake-recutx2', threadId: 'fake-thread', from: { name: 'Fake Sender' },
    text: 'Fake recovered message', receivedAt: '2026-11-17T00:00:00Z' };
  const invalid = shape === 'original' ? { ...valid, from: { name: '\u200b' } }
    : { id: valid.id, from: 'Fake Sender', text: 'Fake invalid date', at: 'invalid' };
  writeFileSync(join(inbox, 'a-invalid.json'), JSON.stringify(invalid));
  writeFileSync(join(inbox, 'b-valid.json'), JSON.stringify(valid));
  const result = await readUnifiedInbox({ runsDir: root, busRoot: join(root, 'bus'),
    now: () => Date.parse('2026-11-17T01:00:00Z') });
  expect(result.sources.linkedin).toEqual({ state: 'degraded', pending: 1 });
  expect(result.items.filter(item => item.source === 'linkedin')).toEqual([expect.objectContaining({
    id: 'linkedin:fake-recutx2', title: 'LinkedIn from Fake Sender: Fake recovered message',
    since: '2026-11-17T00:00:00.000Z', act: ['phm drafts list --status pending'],
  })]);
  expect(readdirSync(base)).toEqual(['inbox']);
});
