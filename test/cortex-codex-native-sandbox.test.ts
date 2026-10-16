/** Exact selected runtimes, synthetic fixtures only; no inference or credentials. */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCortexCodexConfig, CORTEX_CODEX_PERMISSION_CONFIG, cortexCodexConfig } from '../src/core/cortex/codex-policy.js';
import { withCortexCodexRuntime } from '../src/core/cortex/codex-runtime.js';
import type { AshlrConfig } from '../src/core/types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(script = 'exit 73') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cortex-runtime-test-'))); roots.push(root); chmodSync(root, 0o700);
  const executable = join(root, 'codex'); writeFileSync(executable, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  return { root, executable };
}
const noop = () => {};
// These are explicit test targets, never a production fallback or PATH search.
const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const legacy = '/opt/homebrew/bin/codex';
const nativeAvailable = process.platform === 'darwin' && existsSync(bundled);
const legacyAvailable = process.platform === 'darwin' && existsSync(legacy) &&
  spawnSync(legacy, ['--version'], { encoding: 'utf8', timeout: 5000 }).stdout?.trim() === 'codex-cli 0.136.0';

describe.skipIf(process.platform === 'win32')('Cortex exact-executable compatibility proof', () => {
  it('source-owned policy permits only workspace plus host-forced private TMP and rejects config drift', () => {
    expect(CORTEX_CODEX_PERMISSION_CONFIG).toContain('":root"="deny"');
    expect(CORTEX_CODEX_PERMISSION_CONFIG).toContain('":slash_tmp"="deny"');
    expect(CORTEX_CODEX_PERMISSION_CONFIG).toContain('":tmpdir"="write"');
    expect(CORTEX_CODEX_PERMISSION_CONFIG).toContain('network={enabled=false}');
    const config = cortexCodexConfig({} as AshlrConfig); expect(() => assertCortexCodexConfig(config)).not.toThrow();
    config.foundry!.engines!.codex!.autonomousArgv = ['--dangerously-bypass-approvals-and-sandbox'];
    expect(() => assertCortexCodexConfig(config)).toThrow('execution policy changed');
  });
  it('refuses relative executables and revoked policy before any child or provider contact', async () => {
    let contacts = 0;
    await expect(withCortexCodexRuntime('codex', { assertCurrent: noop }, async () => ++contacts)).rejects.toThrow('absolute path');
    const f = fixture(); const config = cortexCodexConfig({} as AshlrConfig); config.foundry!.autoMerge!.enabled = true;
    await expect(withCortexCodexRuntime(f.executable, { assertCurrent: () => assertCortexCodexConfig(config) }, async () => ++contacts)).rejects.toThrow('policy changed');
    expect(contacts).toBe(0);
  });
  it('refuses group/world writable executable files before running their synthetic probe', async () => {
    const f = fixture(); let contacts = 0; chmodSync(f.executable, 0o722);
    await expect(withCortexCodexRuntime(f.executable, { assertCurrent: noop }, async () => ++contacts)).rejects.toThrow('group/world write');
    expect(contacts).toBe(0);
  });
  it.each(['replace', 'rewrite', 'symlink'] as const)('refuses executable %s at the final pre-exec gate without provider contact', async kind => {
    const f = fixture(); const invoked = join(f.root, 'invoked');
    writeFileSync(f.executable, `#!/bin/sh\nprintf called > '${invoked}'\nexit 0\n`, { mode: 0o700 });
    let requested = f.executable;
    if (kind === 'symlink') { requested = join(f.root, 'selected'); symlinkSync(f.executable, requested); }
    let checks = 0; let contacts = 0;
    await expect(withCortexCodexRuntime(requested, { assertCurrent: () => {
      if (++checks !== 3) return;
      if (kind === 'rewrite') writeFileSync(f.executable, '#!/bin/sh\nexit 72\n');
      else {
        const replacement = join(f.root, 'replacement'); writeFileSync(replacement, '#!/bin/sh\nexit 71\n', { mode: 0o700 });
        if (kind === 'replace') renameSync(replacement, f.executable);
        else { unlinkSync(requested); symlinkSync(replacement, requested); }
      }
    } }, async () => ++contacts)).rejects.toThrow('changed');
    expect(contacts).toBe(0); expect(existsSync(invoked)).toBe(false);
  });
  it('does not trust a guest success report without the actual allowed and denied effects', async () => {
    const f = fixture(`printf '%s' '{"inside":true,"scratch":true,"siblingDenied":true,"unrelatedTmpDenied":true,"aliasDenied":true,"privateReadDenied":true,"networkDenied":true}'`);
    let contacts = 0;
    await expect(withCortexCodexRuntime(f.executable, { assertCurrent: noop }, async () => ++contacts)).rejects.toThrow();
    expect(contacts).toBe(0);
  });
  it('rejects an unsandboxed executable despite a working command and removes only its synthetic fixtures', async () => {
    // This fake executes the fixed guest normally; outside effects must expose it.
    const f = fixture('shift 7\nexec "$@"'); let contacts = 0;
    await expect(withCortexCodexRuntime(f.executable, { assertCurrent: noop }, async () => ++contacts)).rejects.toThrow('native sandbox must allow only');
    expect(contacts).toBe(0); expect(existsSync(f.executable)).toBe(true);
  });
  it('does not inherit provider or worker credentials and does not cache a failed proof', async () => {
    const f = fixture(); const log = join(f.root, 'env'); const calls = join(f.root, 'calls');
    writeFileSync(f.executable, `#!/bin/sh\n/usr/bin/env > '${log}'\nprintf x >> '${calls}'\nexit 73\n`, { mode: 0o700 });
    const before = process.env.CORTEX_WORKER_TOKEN; process.env.CORTEX_WORKER_TOKEN = 'synthetic-not-a-secret';
    try {
      for (let i = 0; i < 2; i++) await expect(withCortexCodexRuntime(f.executable, { assertCurrent: noop }, async () => { throw new Error('provider contacted'); })).rejects.toThrow('sandbox refused');
      expect(readFileSync(calls, 'utf8')).toBe('xx');
      const env = readFileSync(log, 'utf8'); expect(env).not.toContain('CORTEX_WORKER_TOKEN'); expect(env).not.toContain('synthetic-not-a-secret');
      expect(env).toMatch(/TMPDIR=.+cortex-codex-proof-.+\/scratch/);
      expect(env).toMatch(/CODEX_HOME=.+cortex-codex-proof-.+\/native-home/);
    } finally { if (before === undefined) delete process.env.CORTEX_WORKER_TOKEN; else process.env.CORTEX_WORKER_TOKEN = before; }
  });
  it('aborts a running synthetic probe promptly with no provider contact', async () => {
    const f = fixture('/bin/sleep 30'); const abort = new AbortController(); let contacts = 0;
    const started = Date.now(); const timer = setTimeout(() => abort.abort(), 200);
    try { await expect(withCortexCodexRuntime(f.executable, { signal: abort.signal, assertCurrent: noop }, async () => ++contacts)).rejects.toThrow(); }
    finally { clearTimeout(timer); }
    expect(Date.now() - started).toBeLessThan(3000); expect(contacts).toBe(0);
  });
  it('bounds a stalled proof without treating a timeout as successful qualification', async () => {
    const f = fixture('/bin/sleep 30'); let contacts = 0; const started = Date.now();
    await expect(withCortexCodexRuntime(f.executable, { assertCurrent: noop }, async () => ++contacts)).rejects.toThrow(/timed out|deadline/);
    expect(Date.now() - started).toBeLessThan(14_000); expect(contacts).toBe(0);
  }, 16_000);
  it('bounds guest output and refuses contact on overflow', async () => {
    const f = fixture('/usr/bin/yes synthetic'); let contacts = 0;
    await expect(withCortexCodexRuntime(f.executable, { assertCurrent: noop }, async () => ++contacts)).rejects.toThrow('output bound');
    expect(contacts).toBe(0);
  });
  it('rechecks executable replacement while a probe is running', async () => {
    const f = fixture('/bin/sleep 30'); let checks = 0; let contacts = 0;
    await expect(withCortexCodexRuntime(f.executable, { assertCurrent: () => {
      if (++checks === 4) { const replacement = join(f.root, 'new'); writeFileSync(replacement, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); renameSync(replacement, f.executable); }
    } }, async () => ++contacts)).rejects.toThrow('identity or content changed');
    expect(contacts).toBe(0);
  });
  it.skipIf(!legacyAvailable)('fails closed on installed legacy Codex that allows unrelated temp writes', async () => {
    let contacts = 0;
    await expect(withCortexCodexRuntime(legacy, { assertCurrent: noop }, async () => ++contacts)).rejects.toThrow('native sandbox must allow only');
    expect(contacts).toBe(0);
  });
  it.skipIf(!nativeAvailable)('proves workspace/private scratch writes, sibling/alias/global TMP and private-read denial, and loopback denial without inference', async () => {
    let captured: (() => boolean) | undefined;
    const value = await withCortexCodexRuntime(bundled, { assertCurrent: noop }, async (selected, current, signal) => {
      expect(selected).toBe(realpathSync(bundled)); expect(current()).toBe(true); expect(signal.aborted).toBe(false); captured = current; return 'synthetic-only';
    });
    expect(value).toBe('synthetic-only'); expect(captured!()).toBe(false);
  }, 20_000);
  it.skipIf(!nativeAvailable)('revalidates source policy during the contact and aborts rather than reusing a qualification cache', async () => {
    const config = cortexCodexConfig({} as AshlrConfig); let contacts = 0;
    await expect(withCortexCodexRuntime(bundled, { assertCurrent: () => assertCortexCodexConfig(config) }, async (_selected, current, signal) => {
      contacts++; config.foundry!.autoMerge!.enabled = true; expect(current()).toBe(false);
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      return 'must not succeed';
    })).rejects.toThrow('execution policy changed');
    expect(contacts).toBe(1);
  }, 20_000);
  it.skipIf(!nativeAvailable)('does not reuse a successful proof after executable replacement at the same selected path', async () => {
    const f = fixture(`exec '${bundled}' "$@"`); let contacts = 0;
    expect(await withCortexCodexRuntime(f.executable, { assertCurrent: noop }, async () => ++contacts)).toBe(1);
    const replacement = join(f.root, 'replacement'); writeFileSync(replacement, '#!/bin/sh\nexit 73\n', { mode: 0o700 }); renameSync(replacement, f.executable);
    await expect(withCortexCodexRuntime(f.executable, { assertCurrent: noop }, async () => ++contacts)).rejects.toThrow('sandbox refused');
    expect(contacts).toBe(1);
  }, 20_000);
});
