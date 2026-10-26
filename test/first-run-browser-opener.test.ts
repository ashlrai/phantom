/**
 * First run on a headless host: `phm verse` / `phm serve --open` /
 * `phm dashboard open` ask the platform opener (xdg-open, open, start) to show
 * the console. When that opener is missing, spawn reports ENOENT through an
 * asynchronous 'error' event. Unhandled, that event killed the freshly started
 * server before the user ever saw a URL. The openers must instead reject so
 * the callers print their "navigate manually" fallback and keep serving.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openBrowser as serveOpenBrowser } from '../src/cli/serve.js';
import { openBrowser as dashboardOpenBrowser } from '../src/cli/dashboard.js';

const origPath = process.env.PATH;
let emptyBin: string;

beforeEach(() => {
  emptyBin = mkdtempSync(join(tmpdir(), 'phm-no-opener-'));
  process.env.PATH = emptyBin;
});

afterEach(() => {
  process.env.PATH = origPath;
  rmSync(emptyBin, { recursive: true, force: true });
});

// Windows resolves `start` through the shell, so it never hits ENOENT here.
describe.skipIf(process.platform === 'win32')('browser opener without a platform opener', () => {
  it('serve/verse opener rejects with ENOENT instead of crashing the process', async () => {
    await expect(serveOpenBrowser('http://127.0.0.1:1/verse/')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('dashboard opener rejects with ENOENT instead of crashing the process', async () => {
    await expect(dashboardOpenBrowser('http://127.0.0.1:1/next/')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
