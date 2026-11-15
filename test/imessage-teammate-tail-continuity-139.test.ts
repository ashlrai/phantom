import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { readTeammateTexts, senderIdFor } from '../src/core/comms/imessage-teammate-inbox.js';
import { runTeammateResponder } from '../src/core/comms/imessage-teammate-worker.js';

let runsDir: string;
const now = () => 1793933400000;
const path = () => join(runsDir, 'imessage', 'teammates.jsonl');
const row = (rowid: number, text: string) => JSON.stringify({ v: 1, at: new Date(now()).toISOString(), rowid, senderId: senderIdFor('fake@example.test'), text });
// A single large old row puts the read boundary inside it; no large collection is needed.
const oversized = () => writeFileSync(path(), `${row(1, 'x'.repeat(8 * 1024 * 1024))}\n`, { mode: 0o600 });
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'team-tail-')); mkdirSync(join(runsDir, 'imessage'), { mode: 0o700 }); });
afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

it('reads a healthy bounded tail and replies only once', async () => {
  oversized();
  appendFileSync(path(), `${row(2, 'Already answered?')}\n${JSON.stringify({ v: 1, answered: 2, at: new Date(now()).toISOString() })}\n${row(3, 'What is the status?')}\n`);
  expect(readTeammateTexts({ runsDir, now })).toMatchObject({ sourceState: 'healthy', texts: [{ rowid: 3 }] });
  const options = { runsDir, now, approved: () => 'fake@example.test', generate: vi.fn(async () => 'Status is unknown.'), send: vi.fn(async () => 'accepted' as const), reconcile: vi.fn(async () => ({ rowid: 9, sent: true, delivered: true, error: 0 })) };
  expect(await runTeammateResponder({} as AshlrConfig, options)).toMatchObject({ state: 'healthy', sent: 1 });
  expect(await runTeammateResponder({} as AshlrConfig, options)).toMatchObject({ state: 'healthy', sent: 0 });
  expect(options.send).toHaveBeenCalledOnce();
  expect(readTeammateTexts({ runsDir, now }).texts).toHaveLength(0);
});

it.each(['{broken}', '{"rowid":"invalid"}', '[]', '{"answered":0}'])('degrades on a retained invalid row: %s', bad => {
  oversized(); appendFileSync(path(), `${bad}\n${row(3, 'Question?')}\n`);
  expect(readTeammateTexts({ runsDir, now })).toMatchObject({ sourceState: 'degraded', texts: [{ rowid: 3 }] });
});

it('preserves the existing final-line convention and degrades a torn final record', () => {
  oversized(); appendFileSync(path(), `${row(3, 'Question?')}\n{"rowid":`);
  expect(readTeammateTexts({ runsDir, now }).sourceState).toBe('degraded');
  writeFileSync(path(), row(3, 'Question?'));
  expect(readTeammateTexts({ runsDir, now })).toMatchObject({ sourceState: 'healthy', texts: [{ rowid: 3 }] });
});

it('degrades when the entire retained tail has no complete leading boundary', () => {
  writeFileSync(path(), 'x'.repeat(8 * 1024 * 1024 + 1));
  expect(readTeammateTexts({ runsDir }).sourceState).toBe('degraded');
});

it('preserves missing and unavailable file handling', () => {
  expect(readTeammateTexts({ runsDir }).sourceState).toBe('missing');
  symlinkSync(join(runsDir, 'absent'), path());
  expect(readTeammateTexts({ runsDir }).sourceState).toBe('missing');
});
