import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/core/comms/imessage-outbox.js', () => ({ sendIMessageOutbox: vi.fn(async () => undefined) }));
vi.mock('../src/core/fleet/channel-bus-publish.js', () => ({ publishChannelEnvelope: vi.fn(async () => 'published') }));

import { writeCursor, type IntakeMsg } from '../src/core/integrations/imessage.js';
import { ingestIMessages } from '../src/core/comms/imessage-inbox-bridge.js';
import { publishChannelEnvelope } from '../src/core/fleet/channel-bus-publish.js';
import type { AshlrConfig } from '../src/core/types.js';

const HANDLE = '+15550000000';
const now = () => new Date('2026-11-04T12:00:00Z');
const cfg = { comms: { enabled: true, imessageHandle: HANDLE, imessageAllow: [HANDLE] } } as AshlrConfig;
const row = (rowid: number): IntakeMsg => ({ rowid, handle: HANDLE, text: 'same local note', ts: 1 });

let tmp: string;
let platform: PropertyDescriptor;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'imsg-bus-local-'));
  for (const k of ['HOME', 'ASHLR_RUNS_DIR']) saved[k] = process.env[k];
  process.env['HOME'] = tmp;
  process.env['ASHLR_RUNS_DIR'] = tmp;
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.mocked(publishChannelEnvelope).mockClear();
  writeCursor(10, tmp, now);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(tmp, { recursive: true, force: true });
});

const ingest = (messages: IntakeMsg[], runsDir: string | undefined) => ingestIMessages(cfg, {
  runsDir, now, poll: async () => ({ ok: true, state: 'ok', messages }),
  maxRowId: async () => ({ ok: true, state: 'ok', rowid: 10 }),
});
const inbox = () => join(tmp, 'leader', 'MASON-INBOX.md');

describe('iMessage stays off the agent bus (Textbot handoff #3472)', () => {
  it('ingests locally and never publishes to the bus', async () => {
    expect(await ingest([row(11)], tmp)).toMatchObject({ state: 'ingested', accepted: 1 });
    expect(readFileSync(inbox(), 'utf8')).toContain('same local note');
    expect(publishChannelEnvelope).not.toHaveBeenCalled();
    expect(existsSync(join(tmp, 'agent-bus'))).toBe(false);
  });
  it('does not publish on the production path (runsDir unset, env-scoped)', async () => {
    // Without publish:null this path enables the default bus sink.
    expect(await ingest([row(11)], undefined)).toMatchObject({ state: 'ingested', accepted: 1 });
    expect(existsSync(inbox())).toBe(true);
    expect(publishChannelEnvelope).not.toHaveBeenCalled();
  });
  it('still counts an identical message in the dedupe window as duplicate', async () => {
    expect(await ingest([row(11), row(12)], tmp)).toMatchObject({ accepted: 1, duplicate: 1 });
    expect(publishChannelEnvelope).not.toHaveBeenCalled();
  });
});
