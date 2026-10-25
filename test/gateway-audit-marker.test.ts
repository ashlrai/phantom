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

  it('an invalid config adds nothing and never echoes input (the client refuses before contact)', () => {
    expect(gatewayAuditSuffix('anthropic', { anthropic: { enabled: true, baseUrl: 'https://SECRETUSER:SECRETPW@gw.example.com' } })).toBe('');
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
