import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdLocalRuntime } from '../src/cli/local-runtime.js';
import { anthropicContentText, normaliseAnthropicRequest } from '../src/core/local-runtime/llama/anthropic-shim.js';
import { isPlainRecord, originFromBaseUrl } from '../src/core/local-runtime/llama/config.js';
import { identifyRuntime, type EndpointReading } from '../src/core/local-runtime/llama/health.js';
import { buildLaunchAgentPlist, installLaunchdJob, renderLaunchdPlist, uninstallLaunchdJob } from '../src/core/local-runtime/llama/launchd.js';
import { ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL, LAUNCH_AGENT_LABEL, anthropicProxyPlistPath, launchAgentPlistPath } from '../src/core/local-runtime/llama/paths.js';
import { buildAnthropicProxyPlist } from '../src/core/local-runtime/llama/proxy-launchd.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-local-runtime-shared-'));
  tempDirs.push(dir);
  return dir;
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('local-runtime shared helpers', () => {
  it('guards plain JSON objects and normalises base URLs to origins', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ port: 8080 })).toBe(true);
    for (const value of [null, undefined, [], 'http://127.0.0.1:8080', 8080]) {
      expect(isPlainRecord(value)).toBe(false);
    }
    expect(originFromBaseUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080');
    expect(originFromBaseUrl('http://[::1]:8081/v1/')).toBe('http://[::1]:8081');
    expect(originFromBaseUrl('not-a-url/v1')).toBe('not-a-url');
    expect(originFromBaseUrl('not-a-url/v1/')).toBe('not-a-url');
  });

  it('derives launch agent plist paths and renders shared launchd XML for both jobs', () => {
    expect(launchAgentPlistPath()).toBe(join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`));
    expect(anthropicProxyPlistPath()).toBe(join(homedir(), 'Library', 'LaunchAgents', `${ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL}.plist`));

    const common = { workingDirectory: '/Users/a&b', stdoutLog: '/Users/a&b/out.log', stderrLog: '/Users/a&b/err.log' };
    expect(buildLaunchAgentPlist({ binPath: '/usr/local/bin/llama-server', args: [], ...common }, '/Users/a&b/llama.sh'))
      .toBe(renderLaunchdPlist({ label: LAUNCH_AGENT_LABEL, shimPath: '/Users/a&b/llama.sh', ...common }));
    expect(buildAnthropicProxyPlist({ command: '/usr/bin/node', args: ['host.js'], host: '127.0.0.1', port: 8081, upstreamPort: 8080, ...common }, '/Users/a&b/proxy.sh'))
      .toBe(renderLaunchdPlist({ label: ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL, shimPath: '/Users/a&b/proxy.sh', ...common }));
  });

  it('handles non-darwin refusal and idempotent file cleanup in shared launchd jobs', () => {
    const dir = makeTempDir();
    const plistPath = join(dir, 'test.plist');
    const shimPath = join(dir, 'test.sh');
    const stampPath = join(dir, 'stamp.json');

    expect(withPlatform('linux', () => installLaunchdJob({
      label: 'ai.ashlr.test', plistPath, shimPath, shimContent: '#!/bin/sh\n', plistContent: '<plist/>',
      writeErrorPrefix: 'could not write test job', loadedDetail: 'loaded', notLoadedDetail: 'not loaded',
    }))).toEqual({
      ok: false, plistPath, loaded: false,
      detail: 'launch agents are a macOS facility; this platform has no equivalent here',
    });

    writeFileSync(plistPath, '<plist/>');
    writeFileSync(shimPath, '#!/bin/sh\n');
    writeFileSync(stampPath, '{}');

    const uninstallOpts = {
      label: 'ai.ashlr.test', plistPath, shimPath, extraRemovePaths: [stampPath],
      removeErrorPrefix: 'could not remove test plist', removedDetail: 'removed', notInstalledDetail: 'not installed',
    };
    expect(withPlatform('linux', () => uninstallLaunchdJob(uninstallOpts))).toEqual({
      ok: true, plistPath, loaded: false, detail: 'removed',
    });
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(shimPath)).toBe(false);
    expect(existsSync(stampPath)).toBe(false);
    expect(withPlatform('linux', () => uninstallLaunchdJob(uninstallOpts))).toEqual({
      ok: true, plistPath, loaded: false, detail: 'not installed',
    });
  });

  it('extracts text consistently across anthropic content arrays and system blocks', () => {
    const blocks = ['first', '', { type: 'image' }, { type: 'text', text: 'second' }, { type: 'text', text: '' }];
    expect(anthropicContentText(blocks)).toBe('first\nsecond');
    const normalised = normaliseAnthropicRequest({
      system: blocks,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: [{ type: 'text', text: 'extra' }, { type: 'image' }] },
      ],
    });
    expect(normalised.system).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
      { type: 'text', text: 'extra' },
    ]);
  });

  it('identifies runtimes consistently across probe states', () => {
    const empty: EndpointReading = { httpStatus: null, body: null, error: 'refused' };
    const noSlots = { configured: null, busy: null, idle: null, source: 'unknown' as const };
    const readings = { health: empty, props: empty, slots: empty };

    expect(identifyRuntime(readings, { configured: 4, busy: 0, idle: 4, source: 'props' }, 'down')).toBe('llama-server');
    expect(identifyRuntime({ ...readings, ollamaVersion: { httpStatus: 200, body: { version: '0.6.0' }, error: null } }, noSlots, 'unknown')).toBe('ollama');
    expect(identifyRuntime(readings, noSlots, 'up')).toBe('llama-server');
    expect(identifyRuntime(readings, noSlots, 'loading')).toBe('llama-server');
    expect(identifyRuntime(readings, noSlots, 'down')).toBe('unknown');
    expect(identifyRuntime(readings, noSlots, 'unknown')).toBe('unknown');
  });

  it('resolves explicit model paths cleanly through cmdLocalRuntime without binary lookup', async () => {
    const dir = makeTempDir();
    const modelFile = join(dir, 'model.gguf');
    writeFileSync(modelFile, 'gguf');

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await cmdLocalRuntime(['resolve-model', '--model-path', modelFile])).toBe(0);
    expect(log).toHaveBeenCalledWith(modelFile);

    const missingFile = join(dir, 'missing.gguf');
    expect(await cmdLocalRuntime(['resolve-model', '--model-path', missingFile])).toBe(1);
    expect(err.mock.calls[0]?.[0]).toContain(missingFile);
  });
});
