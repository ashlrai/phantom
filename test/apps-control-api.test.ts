import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppsControlApi, APPS_CONTROL_PATH } from '../src/core/verse/apps-control-api.js';
import type { AppsControlDeps } from '../src/core/apps-control.js';
import { listNeedsMason, resolveNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { formatAxNode } from '../src/core/verse/verse-mcp-computer.js';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
let root: string;
let allowFile: string;
let oldRuns: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'apps-api-'));
  allowFile = join(root, 'allow.json');
  writeFileSync(allowFile, JSON.stringify({ apps: [
    { name: 'Cursor', bundleId: 'com.example.cursor', actions: ['open', 'focus', 'quit', 'status'] },
    { name: 'Phantom', bundleId: 'ai.ashlr.desktop' }, { name: 'Messages', actions: ['status'] },
  ] }));
  oldRuns = process.env.ASHLR_RUNS_DIR; process.env.ASHLR_RUNS_DIR = root;
});
afterEach(() => {
  if (oldRuns === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = oldRuns;
  rmSync(root, { recursive: true, force: true });
});
const transport = (dirty = false) => vi.fn(async (name: string) => {
  if (name === 'computer_list_apps') return ok('- Cursor (com.example.cursor): up to click only');
  if (name === 'computer_ax_tree') return ok([
    { ref: 'e1', role: 'AXWindow', title: dirty ? 'Draft - Edited' : 'Project' },
    { ref: 'e2', role: 'AXMenuItem', title: 'Quit Cursor' },
  ].map(formatAxNode).join('\n'));
  return ok('pressed');
});
async function request(body?: unknown, options: { method?: string; token?: string; address?: string; channel?: string; allowDispatch?: boolean; deps?: AppsControlDeps } = {}) {
  const req = Object.assign(new PassThrough(), { headers: { 'content-type': 'application/json', 'x-ashlr-token': options.token ?? 'fixture', 'x-ashlr-channel': options.channel ?? '' }, socket: { remoteAddress: options.address ?? '127.0.0.1' } }) as unknown as IncomingMessage;
  let status = 0, response = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(text: string) { response = text; } } as unknown as ServerResponse;
  const handler = createAppsControlApi({ allowFile, feed: () => true, call: transport(), launcher: null, ...options.deps });
  const pending = handler({ token: 'fixture', allowDispatch: options.allowDispatch ?? true } as VerseApiContext, req, res, APPS_CONTROL_PATH, options.method ?? (body === undefined ? 'GET' : 'POST'));
  (req as unknown as PassThrough).end(body === undefined ? '' : JSON.stringify(body));
  await pending;
  return { status, body: JSON.parse(response) };
}

describe('allowlisted console API', () => {
  it('lists the same typed app policy and unknown state as the CLI, including self request mode', async () => {
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.body.apps).toEqual([
      expect.objectContaining({ name: 'Cursor', running: true, actions: ['open', 'focus', 'quit', 'status'], mode: 'direct' }),
      expect.objectContaining({ name: 'Phantom', running: false, mode: 'request' }),
      expect.objectContaining({ name: 'Messages', actions: ['status'] }),
    ]);
    expect((await request(undefined, { deps: { call: async () => ({ ...ok('unavailable'), isError: true }) } })).body.apps[0].running).toBeNull();
  });

  it.each([
    { token: '' }, { address: '192.0.2.1' }, { channel: 'mobile' }, { allowDispatch: false },
  ])('enforces gates before a mutation %j', async options => {
    const call = transport();
    const res = await request({ action: 'quit', app: 'Cursor' }, { ...options, deps: { call } });
    expect([401, 403, 404]).toContain(res.status);
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'type', app: 'Cursor' }, { action: 'quit', app: 'Cursor', confirm: true },
    { action: 'quit', app: 'Cursor', sessionId: 'other-chat' }, { action: 'open', app: 'Cursor', request: 'yes' },
    { action: 'open', app: 'bad\napp' }, { action: 'status', app: 'Cursor', request: true },
  ])('rejects invalid bodies before any transport call %j', async body => {
    const call = transport();
    expect((await request(body, { deps: { call } })).status).toBe(400);
    expect(call).not.toHaveBeenCalled();
  });

  it('enforces enrollment, per-app actions and feed logging before touching the desktop', async () => {
    const call = transport();
    for (const [body, code] of [
      [{ action: 'quit', app: 'Other' }, 'not-allowlisted'],
      [{ action: 'open', app: 'Messages' }, 'action-not-allowed'],
    ] as const) expect((await request(body, { deps: { call } })).body.code).toBe(code);
    expect((await request({ action: 'open', app: 'Cursor' }, { deps: { call, feed: () => false } })).body.code).toBe('feed-unavailable');
    expect(call).not.toHaveBeenCalled();
  });

  it('opens and focuses through the injected host launcher with the enrolled bundle id', async () => {
    const launcher = { open: vi.fn(async () => ({ ok: true as const })), activate: vi.fn(async () => ({ ok: true as const })) };
    expect((await request({ action: 'focus', app: 'Cursor' }, { deps: { launcher } })).status).toBe(200);
    expect(launcher.activate).toHaveBeenCalledExactlyOnceWith('com.example.cursor');
    expect((await request({ action: 'open', app: 'Cursor' }, { deps: { launcher, call: async () => ok('0 running apps:') } })).status).toBe(200);
    expect(launcher.open).toHaveBeenCalledExactlyOnceWith('com.example.cursor');
  });

  it('quits only a readable clean app; unsaved work is persisted to the console needs-you ledger', async () => {
    const clean = transport();
    expect((await request({ action: 'quit', app: 'Cursor' }, { deps: { call: clean } })).body).toMatchObject({ outcome: 'done', logged: true });
    expect(clean.mock.calls.map(c => c[0])).toContain('computer_ax_press');
    const dirty = transport(true);
    const res = await request({ action: 'quit', app: 'Cursor' }, { deps: { call: dirty } });
    expect(res).toMatchObject({ status: 202, body: { outcome: 'needs-you', code: 'unsaved-state' } });
    expect(dirty.mock.calls.map(c => c[0])).not.toContain('computer_ax_press');
    expect(readFileSync(join(root, 'NEEDS-MASON.md'), 'utf8')).toContain('unsaved work');
  });

  it('self actions and fleet job requests reach needs-you; resolution never executes them', async () => {
    const call = transport();
    const launcher = { open: vi.fn(), activate: vi.fn() };
    for (const body of [{ action: 'quit', app: 'Phantom' }, { action: 'focus', app: 'Cursor', request: true }]) {
      expect((await request(body, { deps: { call, launcher } })).status).toBe(202);
    }
    const listed = listNeedsMason({ runsDir: root });
    expect(listed).toHaveLength(2);
    expect(resolveNeedsMason({ itemId: listed[0]!.id, reply: 'Keep running' }, { runsDir: root, bus: { root: join(root, 'bus') } }).ok).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(launcher.open).not.toHaveBeenCalled();
    expect(launcher.activate).not.toHaveBeenCalled();
  });
});
