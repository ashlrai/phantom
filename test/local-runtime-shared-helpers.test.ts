import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { anthropicContentText, normaliseAnthropicRequest } from '../src/core/local-runtime/llama/anthropic-shim.js';
import { originFromBaseUrl } from '../src/core/local-runtime/llama/config.js';
import { identifyRuntime } from '../src/core/local-runtime/llama/health.js';
import {
  buildLaunchAgentPlist,
  buildLaunchAgentShim,
  buildManagedLaunchAgentPlist,
  installManagedLaunchAgent,
  isLaunchAgentLoaded,
  uninstallManagedLaunchAgent,
} from '../src/core/local-runtime/llama/launchd.js';
import {
  ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL,
  LAUNCH_AGENT_LABEL,
  anthropicProxyPlistPath,
  launchAgentPlistPath,
} from '../src/core/local-runtime/llama/paths.js';
import { processAlive, processAliveAsync } from '../src/core/local-runtime/llama/process.js';
import { buildAnthropicProxyPlist } from '../src/core/local-runtime/llama/proxy-launchd.js';
import { missingModelBlockedLine } from '../src/core/local-runtime/missing-model-guard.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashlr-local-runtime-shared-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('local-runtime shared launchd helpers', () => {
  it('derives both LaunchAgents plist paths under ~/Library/LaunchAgents', () => {
    const home = makeTempHome();
    vi.stubEnv('HOME', home);
    expect(launchAgentPlistPath()).toBe(join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`));
    expect(anthropicProxyPlistPath()).toBe(
      join(home, 'Library', 'LaunchAgents', `${ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL}.plist`),
    );
  });

  it('renders identical plist templates for llama-server and the Anthropic proxy with XML escaping', () => {
    const common = {
      workingDirectory: '/Users/dev & ops',
      stdoutLog: '/tmp/out<1>.log',
      stderrLog: '/tmp/err"2".log',
    };
    const shimPath = "/tmp/a'b/shim.sh";

    const llamaPlist = buildLaunchAgentPlist({ binPath: '/usr/local/bin/llama-server', args: [], ...common }, shimPath);
    const proxyPlist = buildAnthropicProxyPlist(
      { command: '/usr/bin/node', args: ['proxy.js'], host: '127.0.0.1', port: 8081, upstreamPort: 8080, ...common },
      shimPath,
    );

    expect(llamaPlist).toBe(buildManagedLaunchAgentPlist({ label: LAUNCH_AGENT_LABEL, shimPath, ...common }));
    expect(proxyPlist).toBe(
      buildManagedLaunchAgentPlist({ label: ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL, shimPath, ...common }),
    );
    expect(llamaPlist).toContain('<string>/Users/dev &amp; ops</string>');
    expect(llamaPlist).toContain('<string>/tmp/out&lt;1&gt;.log</string>');
    expect(llamaPlist).toContain('<string>/tmp/err&quot;2&quot;.log</string>');
    expect(llamaPlist).toContain('<string>/tmp/a&apos;b/shim.sh</string>');
  });

  it('reuses missingModelBlockedLine for inline shim fallback branches', () => {
    const base = {
      binPath: '/usr/local/bin/llama-server',
      args: ['-m', '/tmp/model.gguf'],
      stdoutLog: '/tmp/out.log',
      stderrLog: '/tmp/err.log',
      workingDirectory: '/tmp',
      guardCommand: null,
    };
    const withRef = buildLaunchAgentShim({
      ...base,
      modelRef: 'qwen3.8:27b',
      resolverCommand: ['/usr/local/bin/ashlr', 'local-runtime', 'resolve-model'],
    });
    expect(withRef).toContain(`echo "${missingModelBlockedLine('$REF')}" >&2`);

    const withoutResolver = buildLaunchAgentShim({ ...base, modelRef: null, resolverCommand: null });
    expect(withoutResolver).toContain(`echo "${missingModelBlockedLine('$MODEL')}" >&2`);
  });

  it('checks loaded state via injected launchctl without touching host launchd', () => {
    const calls: string[][] = [];
    expect(isLaunchAgentLoaded('ai.ashlr.test', {
      platform: 'darwin',
      launchctl: (args) => { calls.push(args); return 'state = running'; },
    })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('print');
    expect(calls[0]?.[1]).toMatch(/^gui\/\d+\/ai\.ashlr\.test$/);

    const nonDarwinCalls: string[][] = [];
    expect(isLaunchAgentLoaded('ai.ashlr.test', {
      platform: 'linux',
      launchctl: (args) => { nonDarwinCalls.push(args); return 'ok'; },
    })).toBe(false);
    expect(nonDarwinCalls).toEqual([]);
  });

  it('installs, degrades on bootstrap refusal, reports write failures, and uninstalls cleanly', () => {
    const home = makeTempHome();
    vi.stubEnv('HOME', home);

    const plistPath = join(home, 'Library', 'LaunchAgents', 'ai.ashlr.test.plist');
    const shimPath = join(home, '.ashlr', 'local-runtime', 'test-launch.sh');
    const stampPath = join(home, '.ashlr', 'local-runtime', 'stale-stamp.json');
    const installOpts = {
      label: 'ai.ashlr.test',
      plistPath,
      shimPath,
      shimContent: '#!/bin/sh\necho ok\n',
      plistContent: '<plist>ok</plist>',
      writeFailurePrefix: 'could not write test agent',
      loadedDetail: 'loaded detail',
      notLoadedDetail: 'not loaded detail',
    };
    const uninstallOpts = {
      label: 'ai.ashlr.test',
      plistPath,
      shimPath,
      extraPathsToRemove: [stampPath],
      removeFailurePrefix: 'could not remove test plist',
      removedDetail: 'removed',
      notInstalledDetail: 'nothing to remove',
    };

    expect(installManagedLaunchAgent(installOpts, { platform: 'linux' })).toEqual({
      ok: false,
      plistPath,
      loaded: false,
      detail: 'launch agents are a macOS facility; this platform has no equivalent here',
    });
    expect(existsSync(plistPath)).toBe(false);

    const calls: string[][] = [];
    const installed = installManagedLaunchAgent(
      { ...installOpts, afterWrite: () => writeFileSync(stampPath, '{}') },
      { platform: 'darwin', launchctl: (args) => { calls.push(args); return ''; } },
    );
    expect(installed).toEqual({ ok: true, plistPath, loaded: true, detail: 'loaded detail' });
    expect(readFileSync(shimPath, 'utf8')).toBe('#!/bin/sh\necho ok\n');
    expect(readFileSync(plistPath, 'utf8')).toBe('<plist>ok</plist>');
    if (process.platform !== 'win32') {
      expect(statSync(shimPath).mode & 0o777).toBe(0o700);
      expect(statSync(plistPath).mode & 0o777).toBe(0o644);
    }
    expect(calls.map((c) => c[0])).toEqual(['bootout', 'bootstrap', 'enable', 'print']);

    const failCalls: string[][] = [];
    expect(installManagedLaunchAgent(installOpts, {
      platform: 'darwin',
      launchctl: (args) => { failCalls.push(args); return null; },
    })).toEqual({ ok: true, plistPath, loaded: false, detail: 'not loaded detail' });
    expect(failCalls.map((c) => c[0])).toEqual(['bootout', 'bootstrap']);

    expect(uninstallManagedLaunchAgent(uninstallOpts, { platform: 'darwin', launchctl: () => '' })).toEqual({
      ok: true,
      plistPath,
      loaded: false,
      detail: 'removed',
    });
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(shimPath)).toBe(false);
    expect(existsSync(stampPath)).toBe(false);

    expect(uninstallManagedLaunchAgent(uninstallOpts, { platform: 'darwin', launchctl: () => '' })).toEqual({
      ok: true,
      plistPath,
      loaded: false,
      detail: 'nothing to remove',
    });

    const blockingFile = join(home, 'not-a-dir');
    writeFileSync(blockingFile, 'blocker');
    const badPlistPath = join(blockingFile, 'ai.ashlr.test.plist');
    const writeErr = installManagedLaunchAgent(
      { ...installOpts, plistPath: badPlistPath },
      { platform: 'darwin', launchctl: () => '' },
    );
    expect(writeErr.ok).toBe(false);
    expect(writeErr.loaded).toBe(false);
    expect(writeErr.plistPath).toBe(badPlistPath);
    expect(writeErr.detail).toMatch(/^could not write test agent: /);
  });
});

describe('local-runtime shared URL, shim, health, and process helpers', () => {
  it('derives origin from valid and malformed base URLs consistently', () => {
    expect(originFromBaseUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080');
    expect(originFromBaseUrl('https://localhost:9443/v1/chat/completions')).toBe('https://localhost:9443');
    expect(originFromBaseUrl('malformed-url/v1/')).toBe('malformed-url');
    expect(originFromBaseUrl('malformed-url/v1')).toBe('malformed-url');
  });

  it('extracts text blocks consistently across message content and system arrays', () => {
    expect(
      anthropicContentText(['first', '', { type: 'text', text: 'second' }, { type: 'image', source: {} }, null]),
    ).toBe('first\nsecond');

    const normalised = normaliseAnthropicRequest({
      system: ['preamble', '', { type: 'text', text: 'rules' }, { type: 'other' }],
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'hook' }] },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(normalised.system).toEqual([
      { type: 'text', text: 'preamble' },
      { type: 'text', text: 'rules' },
      { type: 'text', text: 'hook' },
    ]);
  });

  it('identifies unknown runtime for both down and unknown health states', () => {
    const empty = { httpStatus: null, body: null, error: 'refused' };
    const readings = { health: empty, props: empty, slots: empty };
    const unknownSlots = { configured: null, busy: null, idle: null, source: 'unknown' as const };

    expect(identifyRuntime(readings, unknownSlots, 'down')).toBe('unknown');
    expect(identifyRuntime(readings, unknownSlots, 'unknown')).toBe('unknown');
    expect(identifyRuntime(readings, unknownSlots, 'up')).toBe('llama-server');
    expect(
      identifyRuntime(
        { ...readings, ollamaVersion: { httpStatus: 200, body: { version: '0.6.0' }, error: null } },
        unknownSlots,
        'down',
      ),
    ).toBe('ollama');
  });

  it('matches sync and async processAlive invariants on invalid PIDs and current process', async () => {
    for (const invalid of [-1, 0, 1, 1.5, Number.NaN]) {
      expect(processAlive(invalid)).toBe(false);
      expect(await processAliveAsync(invalid)).toBe(false);
    }
    expect(processAlive(process.pid)).toBe(true);
    expect(await processAliveAsync(process.pid)).toBe(true);
  });
});
