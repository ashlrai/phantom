import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMAIL_DROP_CONFIG_FILE } from '../../src/core/comms/email-drop-config.js';
import { readFleetEmailOutbox } from '../../src/mcp/fleet-email-outbox.js';

let root: string;
let outbox: string;
const input = { limit: 10 };
const unavailable = { counts: null, total: null, returned: null, truncated: null, entries: null };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outbox-truth-'));
  outbox = join(root, 'outbox');
  mkdirSync(join(root, 'queue'));
  writeFileSync(join(root, EMAIL_DROP_CONFIG_FILE), JSON.stringify({
    v: 1, inboxDir: join(root, 'inbox'), outboxDir: outbox,
    from: ['owner@example.test'], enabled: false, sendReplies: true,
  }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('fleet email outbox availability', () => {
  it('does not list an existing root when the probe reports unreadable', async () => {
    mkdirSync(outbox);
    const list = vi.fn();
    const probeDir = vi.fn(() => 'unreadable' as const);
    const result = await readFleetEmailOutbox(input, { runsDir: root, probeDir, list });
    expect(probeDir).toHaveBeenCalledWith(outbox);
    expect(list).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sourceState: 'unreadable-outbox', configEnabled: false, sendReplies: true, ...unavailable });
  });

  it.each(['sending', 'sent', 'drafted'])('rejects unreadable %s evidence before listing', async subdir => {
    mkdirSync(outbox);
    writeFileSync(join(outbox, subdir), 'not a directory');
    const list = vi.fn();
    const result = await readFleetEmailOutbox(input, { runsDir: root, list });
    expect(result).toMatchObject({ sourceState: 'unreadable-outbox', ...unavailable });
    expect(list).not.toHaveBeenCalled();
  });

  it('accepts missing optional directories and a valid empty listing', async () => {
    mkdirSync(outbox);
    const result = await readFleetEmailOutbox(input, { runsDir: root });
    expect(result).toMatchObject({ sourceState: 'ok', counts: { queued: 0, sent: 0, drafted: 0, stuck: 0 }, total: 0, returned: 0, truncated: false, entries: [] });
  });

  it('preserves populated metadata and counts', async () => {
    mkdirSync(join(outbox, 'sent'), { recursive: true });
    writeFileSync(join(outbox, 'one.reply.eml'), 'example');
    writeFileSync(join(outbox, 'sent', 'two.reply.eml'), 'example');
    const result = await readFleetEmailOutbox(input, { runsDir: root });
    expect(result).toMatchObject({ sourceState: 'ok', counts: { queued: 1, sent: 1, drafted: 0, stuck: 0 }, total: 2, returned: 2, truncated: false,
      entries: [{ name: 'one.reply.eml', state: 'queued' }, { name: 'two.reply.eml', state: 'sent' }] });
  });

  it('distinguishes a missing root from a non-directory root', async () => {
    expect(await readFleetEmailOutbox(input, { runsDir: root })).toMatchObject({ sourceState: 'missing-outbox', ...unavailable });
    writeFileSync(outbox, 'not a directory');
    expect(await readFleetEmailOutbox(input, { runsDir: root })).toMatchObject({ sourceState: 'unreadable-outbox', ...unavailable });
  });

  it('contains a config reader exception', async () => {
    const list = vi.fn();
    const result = await readFleetEmailOutbox(input, { runsDir: root, list, readConfig: async () => { throw new Error('private-config-error'); } });
    expect(result).toMatchObject({ sourceState: 'invalid-config', configEnabled: null, sendReplies: null, ...unavailable });
    expect(JSON.stringify(result)).not.toContain('private-config-error');
    expect(list).not.toHaveBeenCalled();
  });

  it('contains a probe exception and preserves config flags', async () => {
    mkdirSync(outbox);
    const list = vi.fn();
    const result = await readFleetEmailOutbox(input, { runsDir: root, list, probeDir: () => { throw new Error('private-probe-error'); } });
    expect(result).toMatchObject({ sourceState: 'unreadable-outbox', configEnabled: false, sendReplies: true, ...unavailable });
    expect(JSON.stringify(result)).not.toContain('private-probe-error');
    expect(list).not.toHaveBeenCalled();
  });
});
