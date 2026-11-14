import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = vi.hoisted(() => ({ probe: undefined as undefined | (() => never), read: undefined as undefined | (() => never) }));
vi.mock('../src/core/comms/email-diagnosis.js', async (orig) => {
  const actual = await orig<typeof import('../src/core/comms/email-diagnosis.js')>();
  return { ...actual, probeOutboxDir: (dir: string) => hooks.probe ? hooks.probe() : actual.probeOutboxDir(dir) };
});
vi.mock('../src/core/comms/email-outbox.js', async (orig) => {
  const actual = await orig<typeof import('../src/core/comms/email-outbox.js')>();
  return { ...actual, readEmailOutbox: (dir: string) => hooks.read ? hooks.read() : actual.readEmailOutbox(dir) };
});

import { cmdFleetEmailOutbox } from '../src/cli/fleet-email-outbox.js';
import { writeEmailDropConfig } from '../src/core/comms/email-drop-config.js';

const SECRET = 'private-subject-and-body';
let root: string;
let runsDir: string;
let outboxDir: string;
let out: string[];
let err: string[];
let transport: ReturnType<typeof vi.fn>;

const snapshot = (dir: string): string[] => existsSync(dir)
  ? readdirSync(dir, { recursive: true }).map(String).sort() : [];

beforeEach(async () => {
  hooks.probe = undefined;
  hooks.read = undefined;
  root = mkdtempSync(join(tmpdir(), 'outbox-source-112-'));
  runsDir = join(root, 'runs');
  outboxDir = join(root, 'outbox');
  await writeEmailDropConfig(runsDir, { v: 1, inboxDir: join(root, 'inbox'), outboxDir, from: ['operator@example.test'] });
  out = [];
  err = [];
  transport = vi.fn(async () => ({ ok: true as const }));
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

async function run(args: string[]): Promise<number> {
  const configPath = join(runsDir, 'queue', 'email-drop.json');
  const before = { config: readFileSync(configPath, 'utf8'), tree: snapshot(root) };
  const code = await cmdFleetEmailOutbox(args, { runsDir, transport });
  expect(transport).not.toHaveBeenCalled();
  expect(readFileSync(configPath, 'utf8')).toBe(before.config);
  expect(snapshot(root)).toEqual(before.tree);
  const all = [...out, ...err].join('\n');
  expect(all).not.toContain(SECRET);
  if (code !== 0) expect(all).not.toContain(root); // healthy JSON legitimately carries dir
  return code;
}

describe('fleet email-outbox listing source state', () => {
  it('missing outbox exits 1 without counts or creating it (json)', async () => {
    expect(await run(['--json'])).toBe(1);
    expect(JSON.parse(out[0]!)).toEqual({ error: 'email-outbox-source-unavailable', sourceState: 'missing' });
    expect(existsSync(outboxDir)).toBe(false);
  });

  it('missing outbox exits 1 without counts (human)', async () => {
    expect(await run([])).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('source=missing');
    expect(err.join('\n')).not.toContain('queued=0');
  });

  it('non-directory outbox exits 1', async () => {
    writeFileSync(outboxDir, 'x');
    expect(await run(['--json'])).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ sourceState: 'not-directory' });
    out = [];
    expect(await run([])).toBe(1);
    expect(err.join('\n')).toContain('source=not-directory');
  });

  it('readable empty outbox still exits 0 with unchanged shape', async () => {
    mkdirSync(outboxDir);
    expect(await run(['--json'])).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ dir: outboxDir, counts: { queued: 0, drafted: 0, sent: 0, stuck: 0 }, entries: [] });
    out = [];
    expect(await run([])).toBe(0);
    expect(out).toEqual(['email-outbox: queued=0 drafted=0 sent=0 stuck=0']);
  });

  it('lists queued entries on a healthy outbox', async () => {
    mkdirSync(outboxDir);
    writeFileSync(join(outboxDir, 'a.reply.eml'), 'To: operator@example.test\r\nSubject: s\r\n\r\nb\r\n');
    expect(await cmdFleetEmailOutbox(['--json'], { runsDir, transport })).toBe(0);
    const listing = JSON.parse(out[0]!);
    expect(listing.counts.queued).toBe(1);
    expect(listing.entries[0]).toMatchObject({ name: 'a.reply.eml', state: 'queued' });
  });

  it('probe throwing (race) exits 1 with a fixed code, not the raw error', async () => {
    hooks.probe = () => { throw new Error(`EACCES ${SECRET} ${root}`); };
    expect(await run(['--json'])).toBe(1);
    expect(JSON.parse(out[0]!)).toEqual({ error: 'email-outbox-source-unavailable', sourceState: 'unreadable' });
  });

  it('read failing after a healthy probe exits 1', async () => {
    mkdirSync(outboxDir);
    hooks.read = () => { throw new Error(`boom ${SECRET}`); };
    expect(await run([])).toBe(1);
    expect(err.join('\n')).toContain('source=unreadable');
  });
});
