import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: vi.fn(),
}));

import { isVerifiedMasonHandle, readCursor, writeCursor, type IntakeMsg } from '../src/core/integrations/imessage.js';
import { ingestIMessages } from '../src/core/comms/imessage-inbox-bridge.js';
import type { AshlrConfig } from '../src/core/types.js';

const MASON = '+15550100001';
const OTHER = 'friend@example.com';
const now = () => new Date('2026-11-04T12:00:00Z');
const cfg = (imessageHandle: string | undefined = MASON): AshlrConfig =>
  ({ comms: { enabled: true, imessageHandle, imessageAllow: [MASON, OTHER] } }) as AshlrConfig;
const row = (rowid: number, handle: string): IntakeMsg => ({ rowid, handle, text: `fleet note ${rowid}`, ts: 1 });
let home: string;
let runsDir: string;
let previousHome: string | undefined;
let platform: PropertyDescriptor;

beforeEach(() => {
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'imsg-home-'));
  runsDir = mkdtempSync(join(tmpdir(), 'imsg-runs-'));
  process.env['HOME'] = home;
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  writeCursor(10, runsDir, now);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
});

const ingest = (messages: IntakeMsg[], config = cfg()) => ingestIMessages(config, {
  runsDir, now, poll: async () => ({ ok: true, state: 'ok', messages }),
  maxRowId: async () => ({ ok: true, state: 'ok', rowid: 10 }),
});
const inboxPath = () => join(runsDir, 'leader', 'MASON-INBOX.md');
const expectNoReceipt = () => {
  expect(existsSync(inboxPath())).toBe(false);
  expect(existsSync(join(runsDir, 'imessage', 'acks.jsonl'))).toBe(false);
  expect(existsSync(join(runsDir, 'queue'))).toBe(false);
  expect(existsSync(join(runsDir, 'agent-bus'))).toBe(false);
};

describe('verified Mason intake', () => {
  it('receipts Mason as operator input', async () => {
    expect(await ingest([row(11, MASON)])).toMatchObject({ accepted: 1, notMason: 0 });
    expect(readFileSync(inboxPath(), 'utf8')).toContain('fleet note 11');
  });
  it('skips another allowlisted sender without receipt or ack and advances the cursor', async () => {
    expect(await ingest([row(12, OTHER)])).toMatchObject({ accepted: 0, notMason: 1, cursor: 12 });
    expect(readCursor(runsDir)).toBe(12);
    expectNoReceipt();
  });
  it('receipts only Mason in a mixed batch and advances past the final other sender', async () => {
    expect(await ingest([row(11, OTHER), row(12, MASON), row(13, OTHER)]))
      .toMatchObject({ accepted: 1, notMason: 2, cursor: 13 });
    expect(readCursor(runsDir)).toBe(13);
    const inbox = readFileSync(inboxPath(), 'utf8');
    expect(inbox).toContain('fleet note 12');
    expect(inbox).not.toContain('fleet note 11');
    expect(inbox).not.toContain('fleet note 13');
  });
  it('normalizes case and surrounding spaces', async () => {
    const config = { comms: { enabled: true, imessageHandle: ' Owner@Example.com ', imessageAllow: ['owner@example.com'] } } as AshlrConfig;
    expect(await ingest([row(11, ' OWNER@example.COM ')], config)).toMatchObject({ accepted: 1, notMason: 0 });
  });
  it('receipts nothing without a configured owner even with an allowlist', async () => {
    const config = cfg();
    delete config.comms!.imessageHandle;
    expect(await ingest([row(11, MASON), row(12, OTHER)], config))
      .toMatchObject({ accepted: 0, notMason: 2, cursor: 12 });
    expectNoReceipt();
  });
});

describe('isVerifiedMasonHandle', () => {
  it('requires the configured owner, with normalized case and whitespace', () => {
    expect(isVerifiedMasonHandle(MASON, cfg())).toBe(true);
    expect(isVerifiedMasonHandle(OTHER, cfg())).toBe(false);
    expect(isVerifiedMasonHandle(' OWNER@example.COM ', cfg(' Owner@Example.com '))).toBe(true);
    expect(isVerifiedMasonHandle(MASON, { comms: { imessageAllow: [MASON] } } as AshlrConfig)).toBe(false);
    expect(isVerifiedMasonHandle(' ', cfg(' '))).toBe(false);
  });
});
