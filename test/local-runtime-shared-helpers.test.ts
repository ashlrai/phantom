import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sameFileIdentity, sha256Hex } from '../src/core/local-runtime/archive.js';
import { anthropicContentText, normaliseAnthropicRequest } from '../src/core/local-runtime/llama/anthropic-shim.js';
import { originFromBaseUrl } from '../src/core/local-runtime/llama/config.js';
import {
  buildLaunchAgentPlist,
  launchAgentInstalled,
  renderLaunchAgentPlist,
} from '../src/core/local-runtime/llama/launchd.js';
import {
  ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL,
  LAUNCH_AGENT_LABEL,
  errorMessage,
  isPlainRecord,
} from '../src/core/local-runtime/llama/paths.js';
import { buildAnthropicProxyPlist } from '../src/core/local-runtime/llama/proxy-launchd.js';
import { readBoundedJsonFile } from '../src/core/local-runtime/llama/record.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-runtime-shared-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('local-runtime shared helpers', () => {
  it('narrows plain records and formats unknown error values', () => {
    expect(isPlainRecord({ ok: true })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(['a'])).toBe(false);
    expect(isPlainRecord('text')).toBe(false);
    expect(isPlainRecord(42)).toBe(false);

    expect(errorMessage(new Error('disk full'))).toBe('disk full');
    expect(errorMessage('raw string')).toBe('raw string');
    expect(errorMessage(123)).toBe('123');
  });

  it('reads bounded JSON files safely and rejects missing, oversized, non-file, or corrupt paths', () => {
    const dir = makeTempDir();
    const okPath = join(dir, 'ok.json');
    writeFileSync(okPath, JSON.stringify({ schemaVersion: 1, ok: true }));
    expect(readBoundedJsonFile(okPath, 1024)).toEqual({ schemaVersion: 1, ok: true });
    expect(readBoundedJsonFile(okPath, 5)).toBeNull();

    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, '{not json');
    expect(readBoundedJsonFile(badPath, 1024)).toBeNull();

    const subDir = join(dir, 'sub');
    mkdirSync(subDir);
    expect(readBoundedJsonFile(subDir, 1024)).toBeNull();
    expect(readBoundedJsonFile(join(dir, 'missing.json'), 1024)).toBeNull();
  });

  it('extracts origins from valid URLs and strips trailing /v1 on malformed input', () => {
    expect(originFromBaseUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080');
    expect(originFromBaseUrl('http://[::1]:8081/v1/messages')).toBe('http://[::1]:8081');
    expect(originFromBaseUrl('not a url/v1/')).toBe('not a url');
    expect(originFromBaseUrl('not a url/v1')).toBe('not a url');
  });

  it('renders identical launchd plist XML across llama-server and Anthropic proxy builders', () => {
    const base = {
      workingDirectory: '/Users/dev/work&play',
      stdoutLog: '/Users/dev/.ashlr/logs/out.log',
      stderrLog: '/Users/dev/.ashlr/logs/err.log',
    };
    const llamaShim = '/Users/dev/.ashlr/local-runtime/llama.sh';
    const proxyShim = '/Users/dev/.ashlr/local-runtime/proxy.sh';

    expect(
      buildLaunchAgentPlist({ binPath: '/usr/local/bin/llama-server', args: [], ...base }, llamaShim),
    ).toBe(renderLaunchAgentPlist({ label: LAUNCH_AGENT_LABEL, shimPath: llamaShim, ...base }));

    expect(
      buildAnthropicProxyPlist(
        { command: '/usr/local/bin/node', args: ['proxy.js'], host: '127.0.0.1', port: 8081, upstreamPort: 8080, ...base },
        proxyShim,
      ),
    ).toBe(renderLaunchAgentPlist({ label: ANTHROPIC_PROXY_LAUNCH_AGENT_LABEL, shimPath: proxyShim, ...base }));

    expect(renderLaunchAgentPlist({ label: LAUNCH_AGENT_LABEL, shimPath: llamaShim, ...base }))
      .toContain('/Users/dev/work&amp;play');
  });

  it('checks launchd plist presence without throwing', () => {
    const dir = makeTempDir();
    const plist = join(dir, 'agent.plist');
    expect(launchAgentInstalled(plist)).toBe(false);
    writeFileSync(plist, '<plist/>');
    expect(launchAgentInstalled(plist)).toBe(true);
  });

  it('hashes strings and buffers consistently and compares BigInt file identity', () => {
    expect(sha256Hex('phantom')).toBe(sha256Hex(Buffer.from('phantom', 'utf8')));
    expect(sha256Hex('phantom')).toMatch(/^[0-9a-f]{64}$/);

    const dir = makeTempDir();
    const first = join(dir, 'a.txt');
    const second = join(dir, 'b.txt');
    writeFileSync(first, 'one');
    writeFileSync(second, 'two');
    const statA1 = lstatSync(first, { bigint: true });
    const statA2 = lstatSync(first, { bigint: true });
    const statB = lstatSync(second, { bigint: true });
    expect(sameFileIdentity(statA1, statA2)).toBe(true);
    expect(sameFileIdentity(statA1, statB)).toBe(false);
  });

  it('shares text-block extraction across anthropicContentText and preamble system folding', () => {
    expect(anthropicContentText(['first', { type: 'text', text: 'second' }, { type: 'image' }, ''])).toBe('first\nsecond');
    const normalised = normaliseAnthropicRequest({
      system: ['base', { type: 'text', text: 'extra' }, ''],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: [{ type: 'text', text: 'hook' }] },
      ],
    });
    expect(normalised.system).toEqual([
      { type: 'text', text: 'base' },
      { type: 'text', text: 'extra' },
      { type: 'text', text: 'hook' },
    ]);
    expect(normalised.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
