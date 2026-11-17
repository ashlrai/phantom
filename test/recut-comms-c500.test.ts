import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLinkedInDrop } from '../src/core/comms/linkedin-drop.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(overrides: Record<string, unknown> = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), 'recut-comms-c500-'));
  roots.push(runsDir);
  const base = join(runsDir, 'comms', 'linkedin');
  const inbox = join(base, 'inbox');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, 'original.json'), JSON.stringify({
    id: 'fake-message-c500', threadId: 'fake-thread-c500',
    from: { name: 'Fake Sender' }, text: 'Fake exporter message',
    receivedAt: '2026-11-16T12:00:00Z', ...overrides,
  }));
  return { runsDir, base };
}

describe('C500 original LinkedIn envelope recovery', () => {
  it.each(['2024-02-29T12:00:00.01Z', '0000-02-29T12:00:00Z'])(
    'accepts a real leap day, including years below 100: %s', receivedAt => {
      const { runsDir } = setup({ receivedAt });
      const result = readLinkedInDrop({ runsDir });
      expect(result).toMatchObject({ sourceState: 'healthy', skipped: 0 });
      expect(result.messages).toEqual([{
        id: 'fake-message-c500', from: 'Fake Sender', text: 'Fake exporter message',
        at: new Date(receivedAt).toISOString(),
      }]);
    });

  it.each(['2026-02-29T12:00:00Z', '2026-11-16T24:00:00Z', '2026-11-16', '2026-11-16T12:00:00+00:00'])(
    'rejects a noncanonical or impossible exporter timestamp: %s', receivedAt => {
      const { runsDir } = setup({ receivedAt });
      expect(readLinkedInDrop({ runsDir })).toEqual({ sourceState: 'degraded', skipped: 1, messages: [] });
    });

  it('honors an original handled marker without creating answered markers', () => {
    const { runsDir, base } = setup();
    mkdirSync(join(base, 'handled'));
    writeFileSync(join(base, 'handled', 'fake-message-c500.handled'), '');
    expect(readLinkedInDrop({ runsDir })).toEqual({ sourceState: 'healthy', skipped: 0, messages: [] });
    expect(readdirSync(base).sort()).toEqual(['handled', 'inbox']);
  });

  it('refuses an exporter id that could escape the marker directory', () => {
    const { runsDir } = setup({ id: '../fake-escape' });
    expect(readLinkedInDrop({ runsDir })).toEqual({ sourceState: 'degraded', skipped: 1, messages: [] });
  });
});
