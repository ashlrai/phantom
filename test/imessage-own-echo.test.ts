import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPhantomOwnEcho, PHANTOM_OUTBOUND_FIXED } from '../src/core/comms/imessage-own-echo.js';
import { PAIR_TEXT } from '../src/core/comms/owner-pair.js';
import { ingestIMessages } from '../src/core/comms/imessage-inbox-bridge.js';
import { readCursor } from '../src/core/integrations/imessage.js';
import { sendIMessageOutbox } from '../src/core/comms/imessage-outbox.js';
import type { AshlrConfig } from '../src/core/types.js';

vi.mock('../src/core/comms/imessage-outbox.js', () => ({
  sendIMessageOutbox: vi.fn(async () => ({ ok: true })),
}));

describe('isPhantomOwnEcho', () => {
  it('keeps the fixed pairing text aligned with the sender', () => {
    expect(PHANTOM_OUTBOUND_FIXED[0]).toBe(PAIR_TEXT);
  });

  it.each([
    [PAIR_TEXT, true],
    [` \n${PAIR_TEXT}\t `, true],
    [`Mason says: "${PAIR_TEXT}"`, false],
    [PAIR_TEXT.toLowerCase(), false],
    ['YES', false],
    ['', false],
    [' \t\n', false],
  ])('matches only the complete fixed text: %j', (text, expected) => {
    expect(isPhantomOwnEcho(text)).toBe(expected);
  });

  it('matches recent outbound texts with surrounding whitespace only', () => {
    const recent: readonly string[] = [' \nPhantom acknowledged receipt.\t', ''];
    expect(isPhantomOwnEcho(' Phantom acknowledged receipt. ', recent)).toBe(true);
    expect(isPhantomOwnEcho('I read "Phantom acknowledged receipt."', recent)).toBe(false);
    expect(isPhantomOwnEcho('phantom acknowledged receipt.', recent)).toBe(false);
    expect(isPhantomOwnEcho(' \t', recent)).toBe(false);
  });
});

describe('own echoes at iMessage intake', () => {
  let root: string;
  let runsDir: string;
  const now = () => new Date('2026-11-26T12:00:00Z');
  const cfg = { comms: { enabled: true, imessageHandle: 'mason-test', imessageAllow: ['mason-test', 'teammate-test'] } } as AshlrConfig;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'imessage-own-echo-'));
    runsDir = join(root, 'runs');
    vi.stubEnv('HOME', root);
    vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('consumes the pairing echo and writes only the real Mason row to the inbox', async () => {
    const poll = vi.fn(async () => ({ ok: true as const, messages: [
      { rowid: 11, ts: now().getTime(), handle: 'mason-test', text: ` ${PAIR_TEXT}\n` },
      { rowid: 12, ts: now().getTime(), handle: 'mason-test', text: 'Please check the fleet queue.' },
    ] }));
    const deps = { runsDir, busRoot: join(root, 'bus'), now, platform: 'darwin' as const,
      maxRowId: vi.fn(async () => ({ ok: true as const, rowid: 10 })), poll };

    expect(await ingestIMessages(cfg, deps)).toMatchObject({ state: 'baselined', cursor: 10, ownEcho: 0 });
    const result = await ingestIMessages(cfg, deps);
    expect(result).toMatchObject({ ok: true, state: 'ingested', scanned: 2, accepted: 1,
      ownEcho: 1, notMason: 0, teammate: 0, duplicate: 0, refused: 0, deferred: false, cursor: 12 });
    expect(poll).toHaveBeenCalledWith(10, cfg);
    expect(readCursor(runsDir)).toBe(12);
    const inbox = readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8');
    expect(inbox.match(/\[src:imessage id:/g)).toHaveLength(1);
    expect(inbox).toContain('Please check the fleet queue.');
    expect(inbox).not.toContain(PAIR_TEXT);
    expect(sendIMessageOutbox).toHaveBeenCalledTimes(1);
  });

  it('consumes an echo-only batch before teammate recording or patch handling', async () => {
    const patchFrame = vi.fn();
    const deps = { runsDir, busRoot: join(root, 'bus'), now, platform: 'darwin' as const, patchFrame,
      maxRowId: async () => ({ ok: true as const, rowid: 10 }),
      poll: async () => ({ ok: true as const, messages: [
        { rowid: 11, ts: now().getTime(), handle: 'mason-test', text: PAIR_TEXT },
        { rowid: 12, ts: now().getTime(), handle: 'teammate-test', text: PAIR_TEXT },
      ] }) };
    await ingestIMessages(cfg, deps);
    expect(await ingestIMessages(cfg, deps)).toMatchObject({ ok: true, scanned: 2, accepted: 0,
      ownEcho: 2, notMason: 0, teammate: 0, cursor: 12 });
    expect(readCursor(runsDir)).toBe(12);
    expect(existsSync(join(runsDir, 'leader', 'MASON-INBOX.md'))).toBe(false);
    expect(patchFrame).not.toHaveBeenCalled();
    expect(sendIMessageOutbox).not.toHaveBeenCalled();
  });
});
