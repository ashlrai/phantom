/**
 * openInAshlrMd against a real (fake) mdopen process, without mocking
 * node:child_process.
 *
 * mdopen's CLI mode hands the mdopener:// URL to xdg-open / gio with its own
 * stderr inherited, and when that launcher is still running at mdopen's
 * deadline it exits 0 ("the open is not confirmed") and leaves the launcher
 * running. The launcher then holds whatever mdopen's stderr was. If Phantom
 * reads that stderr through a pipe, spawnSync waits for EOF from the
 * launcher, not for mdopen, so an open that mdopen reported as launched is
 * blocked until Phantom's own timeout and then reported as a failure.
 *
 * The fake mdopen below backgrounds a "launcher" that inherits stderr, notes
 * on stderr, and exits 0. Nothing GUI is run; PATH points only at a temp dir.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openInAshlrMd } from '../src/core/integrations/markdown.js';

describe.skipIf(process.platform === 'win32')('openInAshlrMd with a launcher that outlives mdopen', () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ashlr-m68-launcher-'));
    savedPath = process.env['PATH'];
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns when mdopen exits, reports ok, and keeps mdopen\'s stderr note', () => {
    const script = join(dir, 'mdopen');
    // `sleep` stands in for an xdg-open that is still running: it holds stderr.
    writeFileSync(
      script,
      '#!/bin/sh\nsleep 4 &\necho "mdopen: launched, the open is not confirmed" >&2\nexit 0\n',
      'utf8',
    );
    chmodSync(script, 0o755);
    process.env['PATH'] = `${dir}:/bin:/usr/bin`;

    const started = Date.now();
    const result = openInAshlrMd(join(dir, 'doc.md'));
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('not confirmed');
    expect(elapsed).toBeLessThan(2_500);
  }, 20_000);

  it('still reports a non-zero exit with mdopen\'s stderr', () => {
    const script = join(dir, 'mdopen');
    writeFileSync(script, '#!/bin/sh\necho "mdopen: no display" >&2\nexit 3\n', 'utf8');
    chmodSync(script, 0o755);
    process.env['PATH'] = `${dir}:/bin:/usr/bin`;

    expect(openInAshlrMd(join(dir, 'doc.md'))).toEqual({ ok: false, detail: 'mdopen exit 3: mdopen: no display' });
  });
});
