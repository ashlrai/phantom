/**
 * Governed-client gateway (#880, Option C): run audit events carry a host-only
 * `via=gateway host=<host>` marker when claude-api routes through a configured
 * loopback gateway, and nothing new for first-party runs. Never the key, port,
 * URL or path. Pure: no I/O beyond reading the engine source for the wiring check.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gatewayAuditSuffix } from '../src/core/run/gateway-target.js';

describe('gateway audit marker', () => {
  it('first-party (absent, disabled or other client) adds nothing', () => {
    expect(gatewayAuditSuffix('anthropic', undefined)).toBe('');
    expect(gatewayAuditSuffix('anthropic', { anthropic: { enabled: false, baseUrl: 'http://127.0.0.1:4555' } })).toBe('');
    expect(gatewayAuditSuffix('anthropic', { openaiAgents: { enabled: true, baseUrl: 'http://127.0.0.1:4555' } })).toBe('');
  });

  it('a loopback gateway adds the host only', () => {
    const v4 = gatewayAuditSuffix('anthropic', { anthropic: { enabled: true, baseUrl: 'http://127.0.0.1:4555/gw/prefix' } });
    expect(v4).toBe(' via=gateway host=127.0.0.1');
    expect(v4).not.toContain('4555');
    expect(v4).not.toContain('/gw');
    expect(gatewayAuditSuffix('anthropic', { anthropic: { enabled: true, baseUrl: 'http://[::1]:4555' } })).toBe(' via=gateway host=[::1]');
  });

  it('an invalid config records a closed refusal code and never echoes input (the client refuses before contact)', () => {
    const out = gatewayAuditSuffix('anthropic', { anthropic: { enabled: true, baseUrl: 'https://SECRETUSER:SECRETPW@gw.example.com' } });
    expect(out).toBe(' gateway=refused reason=userinfo-not-allowed');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('gw.example.com');
  });

  it('only loopback gets the gateway marker; non-loopback, IPv6 non-loopback, localhost and lookalikes are refused', () => {
    const at = (baseUrl: string, allowedHosts?: string[]) => gatewayAuditSuffix('anthropic', { anthropic: { enabled: true, baseUrl, ...(allowedHosts ? { allowedHosts } : {}) } });
    expect(at('http://127.0.0.1:4555')).toBe(' via=gateway host=127.0.0.1');
    expect(at('http://[::1]:4555')).toBe(' via=gateway host=[::1]');
    const refused = [
      at('https://gw.example.com', ['gw.example.com:443']),
      at('https://127.0.0.1.evil.com', ['127.0.0.1.evil.com:443']),
      at('https://[2001:db8::1]', ['[2001:db8::1]:443']),
      at('http://[2001:db8::1]:4555'),
      at('http://localhost:4555'),
      at('http://127.0.0.2:4555'),
    ];
    for (const r of refused) {
      expect(r).toMatch(/^ gateway=refused reason=[a-z-]+$/);
      expect(r).not.toContain('via=gateway');
      expect(r).not.toContain('host=');
    }
    expect(refused[1]).toBe(' gateway=refused reason=non-loopback');
  });

  it('a remote https gateway records a value-free refusal, never via=gateway or the host', () => {
    const remote = gatewayAuditSuffix('anthropic', { anthropic: { enabled: true, baseUrl: 'https://gw.example.com', allowedHosts: ['gw.example.com:443'] } });
    expect(remote).toBe(' gateway=refused reason=non-loopback');
    expect(remote).not.toContain('via=gateway');
    expect(remote).not.toContain('host=');
    expect(remote).not.toContain('gw.example.com');
  });

  it('the confinement.run audit event in sandboxed-engine.ts appends the marker for claude-api', () => {
    const src = readFileSync(new URL('../src/core/run/sandboxed-engine.ts', import.meta.url), 'utf8');
    expect(src).toContain("engine === 'claude-api' ? gatewayAuditSuffix('anthropic', (cfg as { gateways?: unknown }).gateways) : ''");
  });
});
