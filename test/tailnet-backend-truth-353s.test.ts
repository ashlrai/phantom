/**
 * RQ-PHX-TAILNETBACKENDTRUTH353S - Test for backend state awareness in tailnet peer reporting.
 * Verifies that when tailscale reports non-running backend states, retained peers
 * with online=true are not reported as current reachability.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTailnetPeers, type TailnetPeersDeps } from '../src/core/fleet/tailnet-peers.js';

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

describe('tailnet backend state awareness', () => {
  it('reports peers with online=true as current reachability when backend is Running', () => {
    const raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', 'Running');
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    expect(result.peers[0]?.online).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('filters out peers with online=true when backend is not Running and reports reasons', () => {
    const raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', 'Stopped');
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    // When backend is stopped, we should not report the online peer as current reachability
    expect(result.peers).toHaveLength(0);
    expect(result.reasons).toContain('tailscale backend not running: Stopped');
  });

  it('properly handles malformed backend state', () => {
    const raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', 'UnknownState');
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    // For unknown state, it should still filter retained online peers
    expect(result.peers).toHaveLength(0);
    expect(result.reasons).toContain('tailscale backend not running: UnknownState');
  });

  it('preserves other reasons when backend is not running', () => {
    const raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', 'Stopped');
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    expect(result.reasons).toContain('tailscale backend not running: Stopped');
  });

  it('handles backend state absence gracefully and preserves normal behavior', () => {
    // Without BackendState, should work like before (backward compatibility)
    const raw = JSON.stringify({
      Self: { HostName: 'fake-self-mac' },
      Peer: {
        'nodekey:a': {
          HostName: 'fake-studio-2', OS: 'macOS', Online: true,
          LastSeen: '2026-11-14T11:58:40.000Z',
        },
      },
    });
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    expect(result.peers[0]?.online).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('reports when backend is in transitioning state', () => {
    const raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
    }, 'fake-self-mac', 'Starting');
    
    const result = readTailnetPeers(deps({ exec: () => raw }));
    expect(result.peers).toHaveLength(0);
    expect(result.reasons).toContain('tailscale backend not running: Starting');
  });
});
