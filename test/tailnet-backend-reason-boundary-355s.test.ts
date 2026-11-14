/**
 * RQ-PHX-TAILNETREASONBOUND355S - Test for sanitization boundary of backend state reasons.
 * Verifies that backend state reasons are properly sanitized and don't leak
 * sensitive information like home paths, IPs, control characters, or unbounded content.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTailnetStatus, readTailnetPeers, type TailnetPeersDeps } from '../src/core/fleet/tailnet-peers.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const HOME = '/Users/fakeuser';

function statusBody(peers: Record<string, unknown>, self: unknown = 'fake-self-mac', backendState: string = 'Running'): string {
  const peerMap: Record<string, unknown> = {};
  for (const key of Object.keys(peers)) {
    peerMap[key] = peers[key];
  }
  return JSON.stringify({
    BackendState: backendState,
    Self: { HostName: self },
    Peer: peerMap,
  });
}

function deps(over: Partial<TailnetPeersDeps> = {}): TailnetPeersDeps {
  return {
    now: () => new Date(NOW),
    homeDir: () => HOME,
    exec: () => statusBody({}),
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('tailnet backend reason sanitization', () => {
  it('should sanitize home paths from backend state reasons', () => {
    const raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', `/Users/fakeuser/long/path/to/some/file/that/should/be/redacted.txt`);
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    // The reason should not contain the full home path
    const reason = result.reasons.find(r => r.includes('tailscale backend not running'));
    expect(reason).toBeDefined();
    expect(reason).not.toContain(HOME);
    expect(reason).toContain('tailscale backend not running: [ip]');
  });

  it('should sanitize IPs from backend state reasons', () => {
    const raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', '192.168.1.100:54321');
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    // The reason should not contain the IP address
    const reason = result.reasons.find(r => r.includes('tailscale backend not running'));
    expect(reason).toBeDefined();
    expect(reason).toContain('tailscale backend not running: [ip]');
  });

  it('should sanitize control characters and newlines from backend state reasons', () => {
    const raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', 'Stopped\nwith\ncontrol\tchars');
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    // The reason should not contain newlines or control characters
    const reason = result.reasons.find(r => r.includes('tailscale backend not running'));
    expect(reason).toBeDefined();
    expect(reason).toContain('tailscale backend not running: Stoppedwithcontrolchars');
  });

  it('should handle very long backend state strings without overflow', () => {
    const longState = 'Running'.repeat(100); // Very long string
    const raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', longState);
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    // The reason should be bounded
    const reason = result.reasons.find(r => r.includes('tailscale backend not running'));
    expect(reason).toBeDefined();
    expect(reason).toContain('tailscale backend not running:');
    // Should not be excessively long (bounded by TEXT_CAP or similar)
    expect(reason.length).toBeLessThan(1000);
  });

  it('should preserve normal functioning when backend is Running', () => {
    const raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', 'Running');
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    // When backend is running, should report peers normally
    expect(result.peers).toHaveLength(1);
    expect(result.peers[0]?.online).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('should preserve known fixed states in reasons', () => {
    const raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', 'Stopped');
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    // Should still have a clear, known reason for Stopped state 
    const reason = result.reasons.find(r => r.includes('tailscale backend not running'));
    expect(reason).toContain('tailscale backend not running: Stopped');
    expect(reason).not.toContain('[ip]');
  });

  it('should provide a generic reason for unknown states instead of raw content', () => {
    const raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', 'SomeUnexpectedState\nWithNewlines');
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    // Should provide a clean, sanitized reason rather than raw unknown state content
    const reason = result.reasons.find(r => r.includes('tailscale backend not running'));
    expect(reason).toBeDefined();
    // The reason should not contain the raw content with newlines
    expect(reason).toContain('tailscale backend not running:');
    // Should not contain newlines or the raw state content
    expect(reason).not.toContain('\n');
    expect(reason).not.toContain('SomeUnexpectedState');
  });

  it('should properly handle edge case where backend state is not a string', () => {
    const raw = JSON.stringify({
      Self: { HostName: 'fake-self-mac' },
      Peer: {
        'nodekey:a': {
          HostName: 'fake-studio-2', OS: 'macOS', Online: true,
          LastSeen: '2026-11-14T11:58:40.000Z',
        },
      },
      BackendState: 123, // Not a string
    });
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    // Should handle non-string backend state gracefully  
    expect(result.reasons).toContain('tailscale backend not running: 123');
  });

  it('should return correct results when transitioning from non-running -> running -> non-running state', () => {
    // Test Running -> arbitrary non-running string -> Running (recovery)
    
    // First, test non-running state
    let raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', 'Stopped');
    
    let result = readTailnetPeers(deps({ exec: () => raw }));
    expect(result.peers).toHaveLength(0); // Should filter out peers since backend not running
    expect(result.reasons).toContain('tailscale backend not running: Stopped');
    
    // Then test recovery to running
    raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', 'Running');
    
    result = readTailnetPeers(deps({ exec: () => raw }));
    expect(result.peers).toHaveLength(1); // Should report peers since backend is running
    expect(result.reasons).toEqual([]); // No reasons since backend is running
    
    // Test another non-running state
    raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', 'Starting');
    
    result = readTailnetPeers(deps({ exec: () => raw }));
    expect(result.peers).toHaveLength(0); // Should filter out peers again
    expect(result.reasons).toContain('tailscale backend not running: Starting');
  });
});
