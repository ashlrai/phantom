/**
 * Regression tests for `phm verse` and `phm serve` startup reporting when web
 * console assets (`next/index.html`) are absent vs built. Hermetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const closeMock = vi.fn(async () => {});
const startServerMock = vi.fn(async () => ({
  port: 7777, url: 'http://127.0.0.1:7777', readToken: 'fake-read-token', token: 'fake-mutation-token', close: closeMock,
}));

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/web/server.js', () => ({ startServer: (...args: unknown[]) => startServerMock(...args) }));
vi.mock('../src/core/verse/apps-api.js', () => ({ warmVerseApps: vi.fn(async () => {}) }));
vi.mock('../src/core/reasoning/reasoning-api.js', () => ({ scheduleReasoningMaintenance: vi.fn(), resetReasoningApiState: vi.fn() }));
vi.mock('../src/core/reasoning/ingest-verse.js', () => ({ flushVerseReasoning: vi.fn() }));
vi.mock('../src/core/verse/verse-log.js', () => ({ installVerseCrashHandlers: vi.fn(() => () => {}) }));
vi.mock('../src/core/verse/verse-api.js', () => ({ peekVerseEngine: vi.fn(() => null) }));

import { cmdServe } from '../src/cli/serve.js';
import { cmdVerse } from '../src/cli/verse.js';

describe('cmdServe and cmdVerse console asset readiness startup output', () => {
  let tmp: string;
  let prevPublic: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-cli-console-assets-'));
    prevPublic = process.env.ASHLR_WEB_PUBLIC;
    process.env.ASHLR_WEB_PUBLIC = tmp;
    closeMock.mockClear();
    startServerMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevPublic === undefined) delete process.env.ASHLR_WEB_PUBLIC;
    else process.env.ASHLR_WEB_PUBLIC = prevPublic;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function runAndStop(fn: () => Promise<number>): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    let signaled = false;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      out.push(args.join(' '));
      if (!signaled) { signaled = true; setImmediate(() => { process.emit('SIGINT'); }); }
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { err.push(args.join(' ')); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return { code: await fn(), out, err };
  }

  for (const [label, invoke] of [
    ['phm serve --json', () => cmdServe(['--port', '7777', '--json'])],
    ['phm verse --json', () => cmdVerse(['--port', '7777', '--no-open', '--no-accounts', '--json'])],
  ] as const) {
    it(`${label} reports consoleAssetsReady false + fix when unbuilt, and true when built`, async () => {
      const unbuilt = await runAndStop(invoke);
      expect(unbuilt.code).toBe(0);
      const parsedUnbuilt = JSON.parse(unbuilt.out[0] ?? '{}') as Record<string, unknown>;
      expect(parsedUnbuilt.consoleAssetsReady).toBe(false);
      expect(parsedUnbuilt.consoleAssetsFix).toContain('npm run build:web');
      expect(unbuilt.err.join('\n')).toContain('Web console UI is not built yet');

      vi.restoreAllMocks();
      fs.mkdirSync(path.join(tmp, 'next'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'next', 'index.html'), '<!doctype html><div id="root"></div>');

      const built = await runAndStop(invoke);
      expect(built.code).toBe(0);
      const parsedBuilt = JSON.parse(built.out[0] ?? '{}') as Record<string, unknown>;
      expect(parsedBuilt.consoleAssetsReady).toBe(true);
      expect(parsedBuilt.consoleAssetsFix).toBeUndefined();
      expect(built.err.join('\n')).not.toContain('Web console UI is not built yet');
    });
  }

  for (const [label, invoke] of [
    ['phm serve (human)', () => cmdServe(['--port', '7777'])],
    ['phm verse (human)', () => cmdVerse(['--port', '7777', '--no-open', '--no-accounts'])],
  ] as const) {
    it(`${label} warns in banner when unbuilt and stays quiet when built`, async () => {
      const unbuilt = await runAndStop(invoke);
      expect(unbuilt.code).toBe(0);
      expect(unbuilt.out.join('\n')).toContain('Web console UI is not built yet');
      expect(unbuilt.out.join('\n')).toContain('npm run build:web');

      vi.restoreAllMocks();
      fs.mkdirSync(path.join(tmp, 'next'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'next', 'index.html'), '<!doctype html><div id="root"></div>');

      const built = await runAndStop(invoke);
      expect(built.code).toBe(0);
      expect(built.out.join('\n')).not.toContain('Web console UI is not built yet');
    });
  }
});
