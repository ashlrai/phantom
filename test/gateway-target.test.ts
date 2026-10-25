/**
 * Governed-client gateway target validator (slice A).
 *
 * Pure unit tests for src/core/run/gateway-target.ts plus the default-config
 * guarantee that no `gateways` block is emitted. Hermetic: no network, no fs
 * writes, no spawn. The validator is not wired into any client yet.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gatewayRequestUrl,
  gatewayViaMarker,
  resolveGatewayTarget,
  validateGatewayBaseUrl,
  type GatewayResolution,
  type GatewayTarget,
} from '../src/core/run/gateway-target.js';
import { defaultConfig, firstRunConfig, GATEWAY_CLIENT_IDS } from '../src/core/config.js';

const LISTED = ['gw.example.com:443'];

function target(resolution: GatewayResolution): GatewayTarget {
  if (!resolution.ok || resolution.target.kind !== 'gateway') {
    throw new Error(`expected gateway target, got ${JSON.stringify(resolution)}`);
  }
  return resolution.target;
}

function reasonOf(resolution: GatewayResolution): string {
  if (resolution.ok) throw new Error('expected refusal');
  return resolution.reason;
}

describe('gateways config defaults', () => {
  it('defaultConfig and firstRunConfig emit no gateways block', () => {
    expect('gateways' in defaultConfig()).toBe(false);
    expect('gateways' in firstRunConfig({})).toBe(false);
  });

  it('names exactly the two governed clients', () => {
    expect([...GATEWAY_CLIENT_IDS]).toEqual(['anthropic', 'openaiAgents']);
  });
});

describe('resolveGatewayTarget: opt-in only', () => {
  const firstParty = { ok: true, target: { kind: 'first-party' } };

  it.each([
    ['absent block', undefined],
    ['null block', null],
    ['empty block', {}],
    ['other client only', { openaiAgents: { enabled: true, baseUrl: 'http://127.0.0.1:4000' } }],
    ['enabled absent', { anthropic: { baseUrl: 'https://gw.example.com', allowedHosts: LISTED } }],
    ['enabled false', { anthropic: { enabled: false, baseUrl: 'https://gw.example.com', allowedHosts: LISTED } }],
    ['enabled string', { anthropic: { enabled: 'true', baseUrl: 'https://gw.example.com', allowedHosts: LISTED } }],
    ['enabled 1', { anthropic: { enabled: 1, baseUrl: 'https://gw.example.com', allowedHosts: LISTED } }],
  ])('%s resolves first-party', (_label, gateways) => {
    expect(resolveGatewayTarget('anthropic', gateways)).toEqual(firstParty);
  });

  it('opted-in valid entry resolves to the gateway', () => {
    const t = target(resolveGatewayTarget('anthropic', {
      anthropic: { enabled: true, baseUrl: 'https://gw.example.com/anthropic', allowedHosts: LISTED },
    }));
    expect(t).toEqual({
      kind: 'gateway', client: 'anthropic', origin: 'https://gw.example.com',
      prefix: '/anthropic', host: 'gw.example.com', port: 443, loopback: false,
    });
    expect(Object.isFrozen(t)).toBe(true);
  });

  it.each([
    ['block is an array', [], 'config-invalid'],
    ['block is a string', 'https://gw.example.com', 'config-invalid'],
    ['entry is a string', { anthropic: 'https://gw.example.com' }, 'entry-invalid'],
    ['entry has unknown key', { anthropic: { enabled: true, baseUrl: 'https://gw.example.com', allowedHosts: LISTED, headers: {} } }, 'unknown-key'],
    ['entry has ca key', { anthropic: { enabled: false, ca: 'x' } }, 'unknown-key'],
    ['opted in without baseUrl', { anthropic: { enabled: true } }, 'base-url-invalid'],
    ['opted in, host not listed', { anthropic: { enabled: true, baseUrl: 'https://gw.example.com' } }, 'host-not-allowlisted'],
  ])('%s refuses (fails closed)', (_label, gateways, reason) => {
    expect(reasonOf(resolveGatewayTarget('anthropic', gateways))).toBe(reason);
  });

  describe('environment never selects a target', () => {
    const saved = { a: process.env['ANTHROPIC_BASE_URL'], o: process.env['OPENAI_BASE_URL'] };
    afterEach(() => {
      if (saved.a === undefined) delete process.env['ANTHROPIC_BASE_URL'];
      else process.env['ANTHROPIC_BASE_URL'] = saved.a;
      if (saved.o === undefined) delete process.env['OPENAI_BASE_URL'];
      else process.env['OPENAI_BASE_URL'] = saved.o;
    });

    it('hostile ANTHROPIC_BASE_URL and OPENAI_BASE_URL change nothing', () => {
      process.env['ANTHROPIC_BASE_URL'] = 'https://evil.example.net';
      process.env['OPENAI_BASE_URL'] = 'http://10.0.0.1:8080';
      for (const client of GATEWAY_CLIENT_IDS) {
        expect(resolveGatewayTarget(client, undefined)).toEqual(firstParty);
      }
      const t = target(resolveGatewayTarget('openaiAgents', {
        openaiAgents: { enabled: true, baseUrl: 'http://127.0.0.1:4000' },
      }));
      expect(t.origin).toBe('http://127.0.0.1:4000');
    });

    it('the module source reads no environment variables', () => {
      const src = readFileSync(resolve(__dirname, '../src/core/run/gateway-target.ts'), 'utf8');
      expect(src).not.toMatch(/process\.env|process\[|getenv|Deno\.env|Bun\.env/);
    });
  });
});

describe('validateGatewayBaseUrl: accepted targets', () => {
  it.each([
    ['https listed default port', 'https://gw.example.com', LISTED, 'https://gw.example.com', '', 443, false],
    ['https listed with prefix and trailing slash', 'https://gw.example.com/a/b/', LISTED, 'https://gw.example.com', '/a/b', 443, false],
    ['https listed explicit default port', 'https://gw.example.com:443/x', LISTED, 'https://gw.example.com', '/x', 443, false],
    ['https listed custom port', 'https://gw.example.com:8443', ['gw.example.com:8443'], 'https://gw.example.com:8443', '', 8443, false],
    ['upper-case host normalized', 'HTTPS://GW.Example.COM', ['Gw.Example.com:443'], 'https://gw.example.com', '', 443, false],
    ['loopback v4 http', 'http://127.0.0.1:4000', undefined, 'http://127.0.0.1:4000', '', 4000, true],
    ['loopback v6 http', 'http://[::1]:4000/v', undefined, 'http://[::1]:4000', '/v', 4000, true],
    ['loopback v4 https', 'https://127.0.0.1:8443', undefined, 'https://127.0.0.1:8443', '', 8443, true],
    ['loopback default http port', 'http://127.0.0.1', undefined, 'http://127.0.0.1', '', 80, true],
  ])('%s', (_label, baseUrl, allowed, origin, prefix, port, loopback) => {
    const t = target(validateGatewayBaseUrl('anthropic', baseUrl, allowed));
    expect(t.origin).toBe(origin);
    expect(t.prefix).toBe(prefix);
    expect(t.port).toBe(port);
    expect(t.loopback).toBe(loopback);
  });
});

describe('validateGatewayBaseUrl: refusals', () => {
  it.each([
    // scheme
    ['http to listed non-loopback', 'http://gw.example.com', ['gw.example.com:80'], 'http-requires-loopback'],
    ['ftp', 'ftp://gw.example.com', LISTED, 'scheme-not-allowed'],
    ['file', 'file:///etc/passwd', LISTED, 'scheme-not-allowed'],
    ['data', 'data:text/plain,hi', LISTED, 'scheme-not-allowed'],
    ['ws', 'ws://127.0.0.1:4000', undefined, 'scheme-not-allowed'],
    ['javascript', 'javascript:alert(1)', LISTED, 'scheme-not-allowed'],
    ['no scheme', 'gw.example.com', LISTED, 'base-url-invalid'],
    ['scheme without slashes', 'https:gw.example.com', LISTED, 'base-url-invalid'],
    // allowlist
    ['https host not listed', 'https://other.example.com', LISTED, 'host-not-allowlisted'],
    ['listed host wrong port', 'https://gw.example.com:8443', LISTED, 'host-not-allowlisted'],
    ['suffix lookalike', 'https://gw.example.com.evil.com', LISTED, 'host-not-allowlisted'],
    ['prefix lookalike', 'https://evil-gw.example.com', LISTED, 'host-not-allowlisted'],
    ['subdomain of listed', 'https://a.gw.example.com', LISTED, 'host-not-allowlisted'],
    ['no allowlist for non-loopback', 'https://gw.example.com', undefined, 'host-not-allowlisted'],
    ['empty allowlist', 'https://gw.example.com', [], 'host-not-allowlisted'],
    ['allowlist entry without port', 'https://gw.example.com', ['gw.example.com'], 'allowlist-invalid'],
    ['allowlist wildcard', 'https://gw.example.com', ['*.example.com:443'], 'allowlist-invalid'],
    ['allowlist with scheme', 'https://gw.example.com', ['https://gw.example.com:443'], 'allowlist-invalid'],
    ['allowlist not an array', 'https://gw.example.com', 'gw.example.com:443', 'allowlist-invalid'],
    ['allowlist non-string', 'https://gw.example.com', [443], 'allowlist-invalid'],
    ['allowlist ip literal', 'https://gw.example.com', ['10.0.0.1:443'], 'allowlist-invalid'],
    ['allowlist localhost', 'https://gw.example.com', ['localhost:443'], 'allowlist-invalid'],
    ['allowlist trailing dot', 'https://gw.example.com', ['gw.example.com.:443'], 'allowlist-invalid'],
    ['allowlist port zero', 'https://gw.example.com', ['gw.example.com:0'], 'allowlist-invalid'],
    // loopback by literal only
    ['localhost name', 'http://localhost:4000', undefined, 'loopback-name-not-allowed'],
    ['localhost name https listed', 'https://localhost:443', ['gw.example.com:443'], 'loopback-name-not-allowed'],
    ['sub.localhost', 'http://api.localhost:4000', undefined, 'loopback-name-not-allowed'],
    ['127.0.0.2', 'http://127.0.0.2:4000', undefined, 'ip-literal-not-allowed'],
    ['0.0.0.0', 'http://0.0.0.0:4000', undefined, 'ip-literal-not-allowed'],
    ['rfc1918', 'https://10.0.0.1', LISTED, 'ip-literal-not-allowed'],
    ['metadata', 'http://169.254.169.254', undefined, 'ip-literal-not-allowed'],
    ['ipv6 other', 'http://[::2]:4000', undefined, 'ip-literal-not-allowed'],
    ['ipv4-mapped v6', 'http://[::ffff:127.0.0.1]:4000', undefined, 'host-not-canonical'],
    ['127.0.0.1 lookalike name', 'http://127.0.0.1.evil.com:4000', undefined, 'http-requires-loopback'],
    // canonical host
    ['numeric shorthand', 'http://127.1:4000', undefined, 'host-not-canonical'],
    ['decimal ip', 'http://2130706433:4000', undefined, 'host-not-canonical'],
    ['hex ip', 'http://0x7f.0.0.1:4000', undefined, 'host-not-canonical'],
    ['expanded v6 loopback', 'http://[0:0:0:0:0:0:0:1]:4000', undefined, 'host-not-canonical'],
    ['trailing dot', 'https://gw.example.com./x', LISTED, 'host-not-canonical'],
    ['percent-encoded host', 'https://gw%2Eexample.com', LISTED, 'host-not-canonical'],
    ['non-ascii host', 'https://g\u00fc.example.com', LISTED, 'base-url-invalid'],
    ['empty host', 'https:///x', LISTED, 'host-not-canonical'],
    // userinfo, query, fragment
    ['userinfo', 'https://user:pass@gw.example.com', LISTED, 'userinfo-not-allowed'],
    ['user only', 'https://user@gw.example.com', LISTED, 'userinfo-not-allowed'],
    ['bare at', 'https://@gw.example.com', LISTED, 'userinfo-not-allowed'],
    ['query', 'https://gw.example.com/x?k=v', LISTED, 'query-not-allowed'],
    ['empty query', 'https://gw.example.com/?', LISTED, 'query-not-allowed'],
    ['fragment', 'https://gw.example.com/#frag', LISTED, 'fragment-not-allowed'],
    ['empty fragment', 'https://gw.example.com#', LISTED, 'fragment-not-allowed'],
    // port
    ['port out of range', 'https://gw.example.com:70000', LISTED, 'base-url-invalid'],
    ['port zero', 'http://127.0.0.1:0', undefined, 'port-invalid'],
    // path
    ['dot-dot segment', 'https://gw.example.com/a/../b', LISTED, 'path-not-allowed'],
    ['dot segment', 'https://gw.example.com/./a', LISTED, 'path-not-allowed'],
    ['encoded dot', 'https://gw.example.com/%2e%2e/a', LISTED, 'path-not-allowed'],
    ['encoded slash', 'https://gw.example.com/a%2Fb', LISTED, 'path-not-allowed'],
    ['double slash', 'https://gw.example.com//a', LISTED, 'path-not-allowed'],
    ['double trailing slash', 'https://gw.example.com/a//', LISTED, 'path-not-allowed'],
    ['backslash', 'https://gw.example.com\\a', LISTED, 'base-url-invalid'],
    ['semicolon', 'https://gw.example.com/a;b', LISTED, 'path-not-allowed'],
    // raw input shape
    ['leading space', ' https://gw.example.com', LISTED, 'base-url-invalid'],
    ['embedded tab', 'https://gw.exa\tmple.com', LISTED, 'base-url-invalid'],
    ['embedded newline', 'https://gw.example.com/a\nb', LISTED, 'base-url-invalid'],
    ['empty string', '', LISTED, 'base-url-invalid'],
    ['too long', `https://gw.example.com/${'a'.repeat(2100)}`, LISTED, 'base-url-invalid'],
    ['number', 443, LISTED, 'base-url-invalid'],
    ['object', { href: 'https://gw.example.com' }, LISTED, 'base-url-invalid'],
  ])('%s', (_label, baseUrl, allowed, reason) => {
    expect(reasonOf(validateGatewayBaseUrl('anthropic', baseUrl, allowed))).toBe(reason);
  });

  it('refusal reasons never contain the input', () => {
    const secretish = 'https://sk-ant-api03-SECRETVALUE:pw@gw.example.com/sk-ant-SECRET?key=SECRETVALUE#SECRETVALUE';
    for (const input of [secretish, 'http://SECRETVALUE.example.com', 'ftp://SECRETVALUE']) {
      const result = validateGatewayBaseUrl('anthropic', input, LISTED);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('SECRET');
    }
  });
});

describe('gatewayRequestUrl', () => {
  const gw = target(validateGatewayBaseUrl('anthropic', 'https://gw.example.com/anthropic/', LISTED));

  it('joins origin, prefix and the fixed api path', () => {
    expect(gatewayRequestUrl(gw, '/v1/messages')).toBe('https://gw.example.com/anthropic/v1/messages');
    const lo = target(validateGatewayBaseUrl('openaiAgents', 'http://127.0.0.1:4000', undefined));
    expect(gatewayRequestUrl(lo, '/v1/agents')).toBe('http://127.0.0.1:4000/v1/agents');
  });

  it.each(['v1/messages', '//evil.com/v1', '/v1/../x', '/v1?x=1', '/v1#f', 'https://evil.com/v1', '/v1\\x', ''])(
    'rejects api path %j',
    (apiPath) => {
      expect(() => gatewayRequestUrl(gw, apiPath)).toThrow('gateway api path invalid');
    },
  );
});

describe('gatewayViaMarker', () => {
  it('records via gateway and the host only', () => {
    const gw = target(validateGatewayBaseUrl('anthropic', 'https://gw.example.com:443/private/prefix', LISTED));
    const marker = gatewayViaMarker(gw);
    expect(marker).toEqual({ via: 'gateway', host: 'gw.example.com' });
    expect(Object.keys(marker).sort()).toEqual(['host', 'via']);
    expect(JSON.stringify(marker)).not.toContain('private');
    expect(Object.isFrozen(marker)).toBe(true);
  });

  it('keeps IPv6 brackets for loopback', () => {
    const lo = target(validateGatewayBaseUrl('openaiAgents', 'http://[::1]:4000', undefined));
    expect(gatewayViaMarker(lo)).toEqual({ via: 'gateway', host: '[::1]' });
  });
});
