/** Exact metadata and real authenticated HTTP; no provider or session execution. */
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/core/verse/session-engine.js', () => { throw new Error('Native metadata must not import a session engine'); });
vi.mock('../src/core/cloud/cloud-api.js', () => { throw new Error('Native metadata must not import scheduler modules'); });
import { readVerseNativeSessionBinding } from '../src/core/verse/session-store.js';
import { peekVerseEngine, resetVerseEngine } from '../src/core/verse/verse-api.js';
import { validVerseNativeSessionBinding } from '../src/core/verse/native-session-binding-types.js';
import { startServer } from '../src/core/web/server.js';
import type { AshlrConfig, WebServerHandle } from '../src/core/types.js';
import * as stable from '../src/core/util/stable-file-read.js';

let home: string; let root: string; let file: string; let handle: WebServerHandle | undefined;
const AT = '2026-10-14T01:02:03.000Z';
function saved(patch: Record<string, unknown> = {}) {
  return { id: 'chat-1', title: 'PRIVATE_TITLE', projectPath: '/PRIVATE_PROJECT', engine: 'codex',
    accountId: 'PRIVATE_ACCOUNT', seatId: 'codex:owner', model: 'PRIVATE_MODEL', nativeSessionId: 'thread-abc_123',
    createdAt: AT, updatedAt: AT, status: 'running', turnCount: 1,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null },
    lastError: 'PRIVATE_ERROR', ...patch };
}
function write(patch: Record<string, unknown> = {}) { writeFileSync(file, JSON.stringify(saved(patch)), { mode: 0o600 }); }
function fingerprint() {
  return readdirSync(join(root, 'sessions')).sort().map(name => {
    const path = join(root, 'sessions', name); const stat = statSync(path);
    return [name, readFileSync(path, 'utf8'), stat.mtimeMs, stat.mode];
  });
}
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'phm-native-binding-')));
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  root = join(homedir(), '.ashlr', 'verse'); mkdirSync(join(root, 'sessions'), { recursive: true, mode: 0o700 });
  file = join(root, 'sessions', 'chat-1.json'); write(); resetVerseEngine(null);
});
afterEach(async () => {
  if (handle) await handle.close(); handle = undefined;
  resetVerseEngine(null); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true });
});
describe('saved native session binding reader', () => {
  it('projects one bounded metadata record without saved-running reconciliation or private fields', () => {
    writeFileSync(join(root, 'sessions', 'chat-1.events.jsonl'), 'PRIVATE_EVENTS');
    writeFileSync(join(root, 'sessions', 'chat-1.launch.json'), 'PRIVATE_LAUNCH');
    const before = fingerprint(); const reader = vi.spyOn(stable, 'readStableRegularFile');
    const result = readVerseNativeSessionBinding('chat-1', root);
    expect(result).toMatchObject({ nativeSessionId: 'thread-abc_123', nativeIdState: 'recorded', savedStatus: 'running',
      savedUpdatedAt: AT, liveOwnerState: 'unverified', desktopAttachment: 'unverified', controlEnabled: false });
    expect(validVerseNativeSessionBinding(result)).toBe(true);
    expect(reader).toHaveBeenCalledExactlyOnceWith(file, { anchorPath: root, maxFileBytes: 1024 * 1024, remainingBytes: 1024 * 1024 });
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(peekVerseEngine()).toBeNull(); expect(fingerprint()).toEqual(before);
  });
  it.each(['claude', 'codex'])('retains safe %s opaque IDs and distinguishes missing from invalid IDs', engine => {
    for (const [nativeSessionId, state] of [[null, 'not-created'], ['native_123-abc', 'recorded'], ['', 'invalid'], ['../../private', 'invalid'], ['a\nPRIVATE', 'invalid'], ['x'.repeat(129), 'invalid']] as const) {
      write({ engine, nativeSessionId }); const row = readVerseNativeSessionBinding('chat-1', root)!;
      expect(row.nativeIdState).toBe(state); expect(row.nativeSessionId).toBe(state === 'recorded' ? nativeSessionId : null);
    }
  });
  it.each(['local', 'grok', 'devin'])('refuses native-ID claims for unsupported %s engine', engine => {
    write({ engine }); expect(readVerseNativeSessionBinding('chat-1', root)).toMatchObject({ engine, nativeSessionId: null, nativeIdState: 'unsupported' });
  });
  it.each([{ id: 'other' }, { engine: 'other' }, { status: 'live' }, { seatId: '/PRIVATE_PATH' }, { seatId: 'x'.repeat(257) },
    { updatedAt: 'yesterday' }, { updatedAt: '2026-02-30T01:02:03.000Z' }, { nativeSessionId: 12 }, { usage: null }])('refuses malformed record %#', patch => {
    write(patch); expect(readVerseNativeSessionBinding('chat-1', root)).toBeNull();
  });
  it('reads fresh saved metadata on each call while never claiming live freshness', () => {
    const first = readVerseNativeSessionBinding('chat-1', root)!;
    write({ status: 'idle', nativeSessionId: 'new-id', updatedAt: '2026-10-14T02:03:04.000Z' });
    const next = readVerseNativeSessionBinding('chat-1', root)!;
    expect(first.savedStatus).toBe('running'); expect(next.savedStatus).toBe('idle'); expect(next.nativeSessionId).toBe('new-id');
    expect(next.liveOwnerState).toBe('unverified'); expect(next.desktopAttachment).toBe('unverified');
  });
  it('refuses traversal/missing IDs before reading, malformed JSON and oversized metadata', () => {
    const reader = vi.spyOn(stable, 'readStableRegularFile');
    for (const id of ['', '..', '../chat-1', 'x'.repeat(129), '/private']) expect(readVerseNativeSessionBinding(id, root)).toBeNull();
    expect(reader).not.toHaveBeenCalled(); expect(readVerseNativeSessionBinding('missing', root)).toBeNull();
    writeFileSync(file, '{oops'); expect(readVerseNativeSessionBinding('chat-1', root)).toBeNull();
    writeFileSync(file, 'x'.repeat(1024 * 1024 + 1)); expect(readVerseNativeSessionBinding('chat-1', root)).toBeNull();
  });
  it.skipIf(process.platform === 'win32')('refuses symlink, hardlink and group-writable metadata without repair', () => {
    const target = join(home, 'target.json'); writeFileSync(target, JSON.stringify(saved()), { mode: 0o600 });
    rmSync(file); symlinkSync(target, file); expect(readVerseNativeSessionBinding('chat-1', root)).toBeNull();
    rmSync(file); linkSync(target, file); expect(readVerseNativeSessionBinding('chat-1', root)).toBeNull();
    rmSync(file); write(); chmodSync(file, 0o666); expect(readVerseNativeSessionBinding('chat-1', root)).toBeNull();
    expect(statSync(file).mode & 0o777).toBe(0o666);
  });
  it('keeps the stable reader Windows ACL-assurance path and refuses failed assurance', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const reader = vi.spyOn(stable, 'readStableRegularFile').mockReturnValue({ ok: false, reason: 'unsafe-file' });
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try { expect(readVerseNativeSessionBinding('chat-1', root)).toBeNull(); expect(reader).toHaveBeenCalledExactlyOnceWith(file, expect.objectContaining({ maxFileBytes: 1024 * 1024 })); }
    finally { Object.defineProperty(process, 'platform', platform); }
  });
});
async function http(path: string, token?: string, method = 'GET') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: handle!.port, method, path,
      headers: { Host: `127.0.0.1:${handle!.port}`, ...(token ? { 'x-ashlr-token': token } : {}) } }, res => {
      let body = ''; res.on('data', part => { body += part; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }); req.once('error', reject); req.end();
  });
}
async function boot() {
  const cfg = { version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {} } as AshlrConfig;
  handle = await startServer(cfg, { port: 0, open: false, allowDispatch: false }, { readProjections: null });
}
describe('native binding authenticated HTTP boundary', () => {
  it('requires existing read authorization and answers before engine/provider module creation', async () => {
    await boot(); const before = fingerprint(); const path = '/api/verse/sessions/chat-1/native-binding';
    const reader = vi.spyOn(stable, 'readStableRegularFile');
    expect((await http(path)).status).toBe(401); expect((await http(path, 'wrong-token')).status).toBe(401); expect(reader).not.toHaveBeenCalled();
    const response = await http(path, handle!.readToken);
    expect(response.status).toBe(200); expect(reader).toHaveBeenCalledExactlyOnceWith(file, expect.objectContaining({ maxFileBytes: 1024 * 1024 })); expect(validVerseNativeSessionBinding(JSON.parse(response.body))).toBe(true);
    expect(response.body).not.toContain('PRIVATE'); expect(peekVerseEngine()).toBeNull(); expect(fingerprint()).toEqual(before);
  });
  it('refuses malformed/unknown/query/unsafe requests with a generic 404 and no store mutation', async () => {
    await boot(); const before = fingerprint();
    for (const path of ['/api/verse/native-binding', '/api/verse/sessions/missing/native-binding', '/api/verse/sessions//native-binding',
      '/api/verse/sessions/%2E%2E_PRIVATE/native-binding', '/api/verse/sessions/%2E%2E/native-binding',
      '/api/verse/sessions/foo/../chat-1/native-binding', '/api/verse/sessions/chat-1/native-binding/extra',
      '/api/verse/sessions/chat-1/native-binding?root=PRIVATE', '/api/verse/sessions/chat-1/native-binding?id=x&id=y']) {
      const response = await http(path, handle!.readToken); expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual({ code: 'VERSE_NATIVE_BINDING_NOT_FOUND', error: 'Native session binding unavailable.' });
    }
    expect((await http('/api/verse/sessions/chat-1/native-binding', handle!.readToken, 'POST')).status).toBe(404);
    expect(peekVerseEngine()).toBeNull(); expect(fingerprint()).toEqual(before);
  });
  it('does not create metadata storage when the selected record is missing', async () => {
    await boot(); rmSync(root, { recursive: true });
    expect((await http('/api/verse/sessions/chat-1/native-binding', handle!.readToken)).status).toBe(404);
    expect(existsSync(root)).toBe(false); expect(peekVerseEngine()).toBeNull();
  });
});
