import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdOutbox } from '../src/cli/outbox.js';
import { outboxFromLog } from '../src/core/fleet/outbox-from-log.js';

const reply = '## 2026-11-19 ~10:00 ET\n\nWork notes.\n\n**Reply for Mason** (for OUTBOXFALLBACK to copy): "All quiet, two changes merged."\n';
let dir: string;
let log: string;
let outbox: string;
const now = () => new Date('2026-11-19T15:00:00.000Z');
const sendToChat = vi.fn(async () => ({ posted: ['one'], skipped: [], unknown: [] }));

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'outbox-from-log-')); log = join(dir, 'PLAN-LOG.md'); outbox = join(dir, 'MASON-OUTBOX.md'); sendToChat.mockClear(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('outbox from-log', () => {
  it('dry run shows the entry and writes nothing', async () => {
    writeFileSync(log, reply);
    const r = await outboxFromLog({ file: log }, { now, sendToChat });
    expect(r).toMatchObject({ schema: 'outbox.from-log.v1', status: 'would-add', apply: false, text: 'All quiet, two changes merged.', entry: '## 2026-11-19T15:00:00.000Z (leader)\n\nAll quiet, two changes merged.\n' });
    expect(() => readFileSync(outbox)).toThrow();
    expect(sendToChat).not.toHaveBeenCalled();
  });

  it('adds a new reply once and sends it to the Leader chat', async () => {
    writeFileSync(log, reply);
    writeFileSync(outbox, '## 2026-11-19T00:00:00.000Z Digest\n\nEarlier digest.\n');
    const first = await outboxFromLog({ file: log, apply: true }, { now, sendToChat });
    expect(first.status).toBe('added');
    expect(first.chat?.posted).toEqual(['one']);
    const second = await outboxFromLog({ file: log, apply: true }, { now, sendToChat });
    expect(second.status).toBe('duplicate');
    const text = readFileSync(outbox, 'utf8');
    expect(text.match(/\(leader\)/g)).toHaveLength(1);
    expect(text).toContain('Earlier digest.');
    expect(sendToChat).toHaveBeenCalledTimes(1);
  });

  it('adds the same reply twice in the log only once', async () => {
    writeFileSync(log, `${reply}\n## 2026-11-19 ~11:00 ET\n\n**Reply for Mason**: "All quiet, two changes merged."\n`);
    await outboxFromLog({ file: log, apply: true }, { now, sendToChat });
    expect((await outboxFromLog({ file: log, apply: true }, { now, sendToChat })).status).toBe('duplicate');
    expect(readFileSync(outbox, 'utf8').match(/\(leader\)/g)).toHaveLength(1);
  });

  it('is a no-op with exit 0 when there is no reply block', async () => {
    writeFileSync(log, '## 2026-11-19 ~10:00 ET\n\nJust notes.\n');
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdOutbox(['from-log', '--file', log, '--apply', '--json'], { sendToChat })).toBe(0);
    expect(JSON.parse(out.mock.calls[0]![0] as string)).toMatchObject({ schema: 'outbox.from-log.v1', status: 'no-reply' });
    expect(() => readFileSync(outbox)).toThrow();
  });

  it('exits 1 for a missing plan log and 2 for bad usage', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdOutbox(['from-log', '--file', join(dir, 'none.md')], { sendToChat })).toBe(1);
    expect(await cmdOutbox(['nope'], { sendToChat })).toBe(2);
  });
});
