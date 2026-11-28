import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cliLocalRuntimeMod from '../src/cli/local-runtime.js';
import * as anthropicProxyMod from '../src/core/local-runtime/llama/anthropic-proxy.js';
import { anthropicContentText, normaliseAnthropicRequest } from '../src/core/local-runtime/llama/anthropic-shim.js';
import * as configMod from '../src/core/local-runtime/llama/config.js';
import * as healthMod from '../src/core/local-runtime/llama/health.js';
import * as indexMod from '../src/core/local-runtime/llama/index.js';
import { buildLaunchAgentPlist, isLaunchAgentInstalled, renderLaunchAgentPlist } from '../src/core/local-runtime/llama/launchd.js';
import * as ollamaBlobMod from '../src/core/local-runtime/llama/ollama-blob.js';
import * as pathsMod from '../src/core/local-runtime/llama/paths.js';
import * as proxyLaunchdMod from '../src/core/local-runtime/llama/proxy-launchd.js';
import * as supervisorMod from '../src/core/local-runtime/llama/supervisor.js';
import * as missingModelGuardMod from '../src/core/local-runtime/missing-model-guard.js';
import * as omlxModelsMod from '../src/core/local-runtime/omlx/models.js';

const tempDirs: string[] = [];
const makeTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('local-runtime shared helpers', () => {
  it('renders identical launch agent plists through the shared launchd template', () => {
    const common = { workingDirectory: '/Users/a & b', stdoutLog: '/Users/a/out.log', stderrLog: '/Users/a/err.log' };
    const llamaShim = '/Users/a/.ashlr/local-runtime/llama-server-launch.sh';
    const proxyShim = '/Users/a/.ashlr/local-runtime/anthropic-proxy-launch.sh';
    expect(buildLaunchAgentPlist({ ...common, binPath: '/opt/llama-server', args: [] }, llamaShim)).toBe(
      renderLaunchAgentPlist({ ...common, label: pathsMod.LAUNCH_AGENT_LABEL, shimPath: llamaShim }),
    );
    expect(
      proxyLaunchdMod.buildAnthropicProxyPlist(
        { ...common, command: '/usr/bin/node', args: [], host: '127.0.0.1', port: 8081, upstreamPort: 8080 },
        proxyShim,
      ),
    ).toBe(renderLaunchAgentPlist({ ...common, label: pathsMod.ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL, shimPath: proxyShim }));

    const plist = join(makeTempDir('local-runtime-plist-'), 'ai.ashlr.test.plist');
    expect(isLaunchAgentInstalled(plist)).toBe(false);
    writeFileSync(plist, '<plist/>');
    expect(isLaunchAgentInstalled(plist)).toBe(true);
  });

  it('extracts origins from valid and malformed base URLs consistently', () => {
    expect(configMod.originFromBaseUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080');
    expect(configMod.originFromBaseUrl('http://[::1]:8080/v1/')).toBe('http://[::1]:8080');
    expect(configMod.originFromBaseUrl('not-a-url/v1/')).toBe('not-a-url');
    expect(configMod.originFromBaseUrl('not-a-url/custom')).toBe('not-a-url/custom');
  });

  it('shares text extraction across anthropicContentText and system-block normalisation', () => {
    expect(anthropicContentText('')).toBe('');
    expect(anthropicContentText(['alpha', '', { type: 'text', text: 'beta' }, { type: 'image' }, null])).toBe('alpha\nbeta');
    const normalised = normaliseAnthropicRequest({
      system: ['outer', '', { type: 'text', text: 'outer-block' }, { type: 'other' }],
      messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: [{ type: 'text', text: 'lifted' }] }],
    });
    expect(normalised.system).toEqual([
      { type: 'text', text: 'outer' },
      { type: 'text', text: 'outer-block' },
      { type: 'text', text: 'lifted' },
    ]);
  });

  it('formats non-library Ollama refs consistently across forward and reverse lookup', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const root = makeTempDir('local-runtime-ollama-');
    const manifestDir = join(root, 'manifests', 'registry.ollama.ai', 'team', 'coder');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'v2'), JSON.stringify({
      layers: [{ mediaType: 'application/vnd.ollama.image.model', digest, size: 1024 }],
    }));
    expect(ollamaBlobMod.parseOllamaModelRef('team/coder:v2')?.canonical).toBe('team/coder:v2');
    expect(ollamaBlobMod.resolveOllamaRefForBlobPath(join(root, 'blobs', digest.replace(':', '-')), root)).toBe('team/coder:v2');
  });

  it('validates CLI string flags and reports install refusals cleanly', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cliLocalRuntimeMod.cmdLocalRuntime(['status', '--model'])).toBe(2);
    expect(errSpy.mock.calls[0]?.[0]).toContain('--model expects a value');
    expect(await cliLocalRuntimeMod.cmdLocalRuntime(['status', '--model-path', '--json'])).toBe(2);
    expect(errSpy.mock.calls[1]?.[0]).toContain('--model-path expects a value');

    const fakeHome = makeTempDir('local-runtime-kill-');
    mkdirSync(join(fakeHome, '.ashlr'), { recursive: true });
    writeFileSync(join(fakeHome, '.ashlr', 'KILL'), 'engaged\n');
    const prevHome = process.env['HOME'];
    process.env['HOME'] = fakeHome;
    try {
      expect(await cliLocalRuntimeMod.cmdLocalRuntime(['install', '--json'])).toBe(1);
      expect(JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '{}'))).toMatchObject({
        ok: false,
        action: 'refused',
        plistPath: join(fakeHome, 'Library', 'LaunchAgents', 'ai.ashlr.local-runtime.plist'),
      });
    } finally {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
    }
  });

  it('does not export pruned dead helpers or constants', () => {
    const absent: Array<[Record<string, unknown>, readonly string[]]> = [
      [cliLocalRuntimeMod, ['localRuntimeLaunchAgentInstalled']],
      [anthropicProxyMod, ['ANTHROPIC_MESSAGES_PATH', 'MAX_NORMALISED_BODY_BYTES']],
      [configMod, ['DEFAULT_LLAMA_SLOTS', 'DEFAULT_LLAMA_CONTEXT', 'LOCAL_AGENT_REASONING_EFFORTS', 'resolveLlamaServerBin']],
      [healthMod, ['OLLAMA_PARALLEL_REFUSAL']],
      [ollamaBlobMod, ['ollamaManifestPath']],
      [pathsMod, ['ashlrHome']],
      [proxyLaunchdMod, ['anthropicProxyAgentInstalled', 'anthropicProxyAgentLoaded']],
      [supervisorMod, ['DEFAULT_START_TIMEOUT_MS', 'isPortFree']],
      [missingModelGuardMod, ['MISSING_MODEL_POLL_MS']],
      [omlxModelsMod, ['LANE_MODEL_ENVELOPE_FRACTION', 'LANE_PROCESS_OVERHEAD_BYTES', 'LOCAL_MODEL_CAPS']],
      [indexMod, [
        'ANTHROPIC_MESSAGES_PATH', 'MAX_NORMALISED_BODY_BYTES', 'DEFAULT_LLAMA_SLOTS', 'DEFAULT_LLAMA_CONTEXT',
        'resolveLlamaServerBin', 'OLLAMA_PARALLEL_REFUSAL', 'anthropicProxyAgentInstalled',
        'anthropicProxyAgentLoaded', 'DEFAULT_START_TIMEOUT_MS', 'isPortFree',
      ]],
    ];
    for (const [mod, names] of absent) {
      for (const name of names) expect(name in mod).toBe(false);
    }
  });
});
