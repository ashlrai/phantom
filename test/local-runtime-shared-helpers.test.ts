import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originFromBaseUrl } from '../src/core/local-runtime/llama/config.js';
import {
  buildLaunchAgentPlist, installManagedLaunchAgent, renderManagedLaunchAgentPlist,
  uninstallManagedLaunchAgent,
} from '../src/core/local-runtime/llama/launchd.js';
import {
  ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL, LAUNCH_AGENT_LABEL, anthropicProxyPlistPath,
  formatErrorMessage, isNonNegativeSafeInt, isPositiveSafeInt, isRecord, isRegularFile,
  launchAgentPlistPath, readBoundedJsonFile,
} from '../src/core/local-runtime/llama/paths.js';
import { buildAnthropicProxyPlist } from '../src/core/local-runtime/llama/proxy-launchd.js';
import { OMLX_GIB, OMLX_MIB, floorToMib, isOmlxRecord } from '../src/core/local-runtime/omlx/models.js';
import { cmdLocalRuntime } from '../src/cli/local-runtime.js';

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('local-runtime shared guards and bounded file helpers', () => {
  it('validates plain records, safe integers and error messages consistently', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect([null, undefined, [], 'text', 42].every((v) => !isRecord(v))).toBe(true);

    expect(isNonNegativeSafeInt(0)).toBe(true);
    expect(isNonNegativeSafeInt(5)).toBe(true);
    expect([-1, 1.5, Number.POSITIVE_INFINITY, '0'].every((v) => !isNonNegativeSafeInt(v))).toBe(true);

    expect(isPositiveSafeInt(1)).toBe(true);
    expect([0, -3, Number.NaN, '1'].every((v) => !isPositiveSafeInt(v))).toBe(true);

    expect(formatErrorMessage(new Error('boom'))).toBe('boom');
    expect(formatErrorMessage('plain')).toBe('plain');
    expect(formatErrorMessage(404)).toBe('404');
  });

  it('checks regular files and reads bounded JSON without throwing', () => {
    const dir = makeTempDir('local-runtime-helpers-');
    const jsonFile = join(dir, 'record.json');
    const badFile = join(dir, 'bad.json');
    const bigFile = join(dir, 'big.json');
    writeFileSync(jsonFile, JSON.stringify({ ok: true, n: 3 }), 'utf8');
    writeFileSync(badFile, '{not-json', 'utf8');
    writeFileSync(bigFile, JSON.stringify({ pad: 'x'.repeat(200) }), 'utf8');

    expect(isRegularFile(jsonFile)).toBe(true);
    expect(isRegularFile(dir)).toBe(false);
    expect(isRegularFile(join(dir, 'missing.json'))).toBe(false);

    expect(readBoundedJsonFile(jsonFile, 1024)).toEqual({ ok: true, n: 3 });
    expect(readBoundedJsonFile(badFile, 1024)).toBeNull();
    expect(readBoundedJsonFile(bigFile, 64)).toBeNull();
    expect(readBoundedJsonFile(dir, 1024)).toBeNull();
    expect(readBoundedJsonFile(join(dir, 'missing.json'), 1024)).toBeNull();
  });

  it('derives launchd plist paths from labels under Library/LaunchAgents', () => {
    expect(launchAgentPlistPath()).toMatch(new RegExp(`Library/LaunchAgents/${LAUNCH_AGENT_LABEL.replaceAll('.', '\\.')}\\.plist$`));
    expect(anthropicProxyPlistPath()).toMatch(
      new RegExp(`Library/LaunchAgents/${ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL.replaceAll('.', '\\.')}\\.plist$`),
    );
  });
});

describe('local-runtime shared URL and launchd helpers', () => {
  it('extracts origins from OpenAI-compatible base URLs with malformed fallback', () => {
    expect(originFromBaseUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080');
    expect(originFromBaseUrl('https://[::1]:8443/v1/')).toBe('https://[::1]:8443');
    expect(originFromBaseUrl('not-a-url/v1/')).toBe('not-a-url');
  });

  it('renders identical plist framing across llama-server and proxy launch agents', () => {
    const common = { workingDirectory: '/tmp/work&dir', stdoutLog: '/tmp/out.log', stderrLog: '/tmp/err.log' };
    const shimPath = '/tmp/agent.sh';
    expect(buildLaunchAgentPlist({ binPath: '/usr/bin/llama-server', args: [], ...common }, shimPath))
      .toBe(renderManagedLaunchAgentPlist({ label: LAUNCH_AGENT_LABEL, shimPath, ...common }));
    expect(buildAnthropicProxyPlist(
      { command: '/usr/bin/node', args: [], host: '127.0.0.1', port: 8081, upstreamPort: 8080, ...common },
      shimPath,
    )).toBe(renderManagedLaunchAgentPlist({ label: ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL, shimPath, ...common }));
  });

  it('reports install write failures and cleanly removes files on uninstall', () => {
    const dir = makeTempDir('local-runtime-launchd-');
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'file', 'utf8');

    const failed = installManagedLaunchAgent({
      label: 'ai.ashlr.test-unused-install',
      plistPath: join(blocker, 'agent.plist'),
      shimPath: join(dir, 'agent.sh'),
      shimContent: '#!/bin/sh\n',
      plistContent: '<plist/>',
      subject: 'test launch agent',
      runtimeNoun: 'the test',
    });
    expect(failed.ok).toBe(false);
    expect(failed.loaded).toBe(false);
    expect(failed.detail).toContain(process.platform === 'darwin' ? 'could not write the test launch agent:' : 'macOS facility');

    const sub = join(dir, 'agents');
    mkdirSync(sub, { recursive: true });
    const plistPath = join(sub, 'agent.plist');
    const shimPath = join(sub, 'agent.sh');
    const extraPath = join(sub, 'stamp.json');
    writeFileSync(plistPath, '<plist/>', 'utf8');
    writeFileSync(shimPath, '#!/bin/sh\n', 'utf8');
    writeFileSync(extraPath, '{}', 'utf8');

    const removed = uninstallManagedLaunchAgent({
      label: 'ai.ashlr.test-unused-uninstall',
      plistPath, shimPath, subject: 'test launch agent', plistLabel: 'test plist',
      extraRemovePaths: [extraPath],
    });
    expect(removed).toEqual({ ok: true, plistPath, loaded: false, detail: 'test launch agent booted out and removed' });
    expect(existsSync(plistPath) || existsSync(shimPath) || existsSync(extraPath)).toBe(false);

    const again = uninstallManagedLaunchAgent({
      label: 'ai.ashlr.test-unused-uninstall',
      plistPath, shimPath, subject: 'test launch agent', plistLabel: 'test plist',
    });
    expect(again.detail).toBe('no test launch agent was installed; nothing to remove');
  });
});

describe('oMLX shared helpers and local-runtime CLI flag parsing', () => {
  it('shares MiB/GiB units, object guards and MiB flooring', () => {
    expect(OMLX_MIB).toBe(1024 ** 2);
    expect(OMLX_GIB).toBe(1024 ** 3);
    expect(isOmlxRecord({ ok: 1 })).toBe(true);
    expect(isOmlxRecord(null)).toBe(false);
    expect(isOmlxRecord([])).toBe(false);
    expect(floorToMib(3 * OMLX_MIB + 512)).toBe(3 * OMLX_MIB);
    expect(floorToMib(0)).toBe(0);
  });

  it('rejects missing values for --model and --model-path and resolves regular model files', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await cmdLocalRuntime(['resolve-model', '--model'])).toBe(2);
    expect(String(err.mock.calls.at(-1)?.[0] ?? '')).toContain('--model expects a value');
    expect(await cmdLocalRuntime(['resolve-model', '--model-path', '--json'])).toBe(2);
    expect(String(err.mock.calls.at(-1)?.[0] ?? '')).toContain('--model-path expects a value');

    const dir = makeTempDir('local-runtime-cli-');
    const modelFile = join(dir, 'model.gguf');
    writeFileSync(modelFile, 'gguf', 'utf8');

    expect(await cmdLocalRuntime(['resolve-model', '--model-path', modelFile])).toBe(0);
    expect(log).toHaveBeenLastCalledWith(modelFile);
    expect(await cmdLocalRuntime(['resolve-model', '--model-path', join(dir, 'missing.gguf')])).toBe(1);
    expect(String(err.mock.calls.at(-1)?.[0] ?? '')).toContain('configured modelPath does not exist');
  });
});
