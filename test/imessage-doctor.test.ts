/**
 * RQ-IMSG-BRIDGE-1: `phm imessage doctor` evidence. Injected seams only: no
 * real chat.db, no real sqlite3, no process-tree reads.
 */
import { describe, expect, it } from 'vitest';
import { buildDoctorReport, probeChatDb } from '../src/core/integrations/imessage.js';
import type { AshlrConfig } from '../src/core/types.js';

const cfg = (comms: Record<string, unknown>) => ({ comms }) as unknown as AshlrConfig;
const base = {
  parentApp: async () => 'Terminal',
  sqliteVersion: async () => '3.45.0',
  lastSend: () => null,
  execPath: '/usr/local/bin/node',
};
const by = (r: Awaited<ReturnType<typeof buildDoctorReport>>, id: string) => r.checks.find((c) => c.id === id)!;

describe('buildDoctorReport', () => {
  const darwin = process.platform === 'darwin';

  it('emits the five checks, each with a fixHint string', async () => {
    const r = await buildDoctorReport({ ...base, cfg: cfg({ enabled: true, imessageHandle: '<MASON_HANDLE>' }), probe: () => 'ok' });
    expect(r.checks.map((c) => c.id)).toEqual(['config_handle', 'chat_db_readable', 'responsible_binary', 'sqlite3_present', 'automation_messages']);
    for (const c of r.checks) expect(typeof c.fixHint).toBe('string');
    expect(by(r, 'config_handle').state).toBe('set');
    expect(by(r, 'responsible_binary').detail).toBe('execPath=/usr/local/bin/node parentApp=Terminal');
    expect(by(r, 'sqlite3_present')).toMatchObject({ state: 'ok', detail: 'sqlite3 3.45.0' });
    expect(by(r, 'automation_messages').state).toBe('unknown');
    expect(JSON.stringify(r)).not.toContain('<MASON_HANDLE>');
  });

  it.runIf(darwin)('names the Full Disk Access path and the responsible app when chat.db is blocked', async () => {
    const r = await buildDoctorReport({ ...base, cfg: cfg({ enabled: true, imessageHandle: 'h' }), probe: () => 'blocked_full_disk_access' });
    const c = by(r, 'chat_db_readable');
    expect(c.state).toBe('blocked_full_disk_access');
    expect(c.fixHint).toContain('System Settings > Privacy & Security > Full Disk Access');
    expect(c.fixHint).toContain('Terminal');
    expect(r.ok).toBe(false);
  });

  it.runIf(darwin)('reports a missing chat.db', async () => {
    const r = await buildDoctorReport({ ...base, cfg: cfg({ enabled: true, imessageHandle: 'h' }), probe: () => 'missing' });
    expect(by(r, 'chat_db_readable').state).toBe('missing');
  });

  it('reports config_handle not_set and unavailable', async () => {
    expect(by(await buildDoctorReport({ ...base, cfg: cfg({ enabled: true }) }), 'config_handle').state).toBe('not_set');
    expect(by(await buildDoctorReport({ ...base, cfg: null }), 'config_handle').state).toBe('unavailable');
  });

  it('counts imessageAllow entries without printing them', async () => {
    const r = await buildDoctorReport({ ...base, cfg: cfg({ enabled: true, imessageAllow: ['<A>', '<B>'] }) });
    expect(by(r, 'config_handle').detail).toContain('2 allowlisted');
    expect(JSON.stringify(r)).not.toContain('<A>');
  });

  it('reports sqlite3 missing', async () => {
    const r = await buildDoctorReport({ ...base, cfg: cfg({}), sqliteVersion: async () => null });
    expect(by(r, 'sqlite3_present').state).toBe('missing');
  });

  it('treats a last send error -1743 as blocked, with the Automation path', async () => {
    const r = await buildDoctorReport({ ...base, cfg: cfg({}), lastSend: () => ({ ok: false, errorCode: '-1743' }) });
    const c = by(r, 'automation_messages');
    expect(c.state).toBe('blocked');
    expect(c.fixHint).toContain('System Settings > Privacy & Security > Automation');
  });

  it('distinguishes a successful and a different failed last send', async () => {
    expect(by(await buildDoctorReport({ ...base, cfg: cfg({}), lastSend: () => ({ ok: true }) }), 'automation_messages').state).toBe('ok');
    expect(by(await buildDoctorReport({ ...base, cfg: cfg({}), lastSend: () => ({ ok: false, errorCode: '-1728' }) }), 'automation_messages').state).toBe('error');
  });
});

describe('probeChatDb', () => {
  it('reports missing for a path that does not exist', () => {
    expect(probeChatDb('/nonexistent-dir-for-imessage-doctor/chat.db')).toBe('missing');
  });
});
