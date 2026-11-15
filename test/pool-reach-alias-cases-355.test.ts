import { joinPoolReach } from '../src/core/fleet/pool-reach.js';
import { describe, it, expect } from 'vitest';

describe('pool-reach alias matching cases', () => {
  it('case 1: alias MAC-B matches peer mac-b.tail-x.ts.net case-insensitively', () => {
    const config = { role:'primary', node:'n1', owner:'o1', primary:'mac-a', backup:'MAC-B' };
    const peers = {
      asOf: '2026-11-14T10:00:00Z',
      self: 'self-peer',
      peers: [
        { name: 'mac-b.tail-x.ts.net', online: true, lastSeen: '2026-11-14T09:00:00Z', ageSeconds: 3600 }
      ],
      reasons: []
    };
    
    const result = joinPoolReach(config, null, peers, '');
    
    // Check the backup host (slot: 'backup') since that's the one that matches the alias
    const backupHost = result.hosts.find(h => h.slot === 'backup');
    expect(backupHost).toBeDefined();
    expect(backupHost!.matched).toBe('mac-b.tail-x.ts.net');
    expect(backupHost!.online).toBe(true);
    expect(backupHost!.lastSeen).toBe('2026-11-14T09:00:00Z');
    expect(backupHost!.ageSeconds).toBe(3600);
    expect(backupHost!.isSelf).toBe(false);
  });

  it('case 2: alias mac-b.tail-y.ts.net does NOT match peer mac-b.tail-x.ts.net', () => {
    const config = { role:'primary', node:'n1', owner:'o1', primary:'mac-a', backup:'mac-b.tail-y.ts.net' };
    const peers = {
      asOf: '2026-11-14T10:00:00Z',
      self: 'self-peer',
      peers: [
        { name: 'mac-b.tail-x.ts.net', online: true, lastSeen: '2026-11-14T09:00:00Z', ageSeconds: 3600 }
      ],
      reasons: []
    };
    
    const result = joinPoolReach(config, null, peers, '');
    
    // Check the backup host (slot: 'backup') since that's the one that has the alias
    const backupHost = result.hosts.find(h => h.slot === 'backup');
    expect(backupHost).toBeDefined();
    expect(backupHost!.matched).toBe('unknown');
    expect(backupHost!.online).toBe('unknown');
    expect(backupHost!.isSelf).toBe(false);
    expect(result.reasons.some(r => r.includes('no tailnet peer named'))).toBe(true);
  });

  it('case 3: two peers mac-b and mac-b.tail-x.ts.net both match: matched unknown, online unknown', () => {
    const config = { role:'primary', node:'n1', owner:'o1', primary:'mac-a', backup:'mac-b' };
    const peers = {
      asOf: '2026-11-14T10:00:00Z',
      self: 'self-peer',
      peers: [
        { name: 'mac-b', online: true, lastSeen: '2026-11-14T09:00:00Z', ageSeconds: 3600 },
        { name: 'mac-b.tail-x.ts.net', online: false, lastSeen: '2026-11-14T08:00:00Z', ageSeconds: 7200 }
      ],
      reasons: []
    };
    
    const result = joinPoolReach(config, null, peers, '');
    
    // Check the backup host (slot: 'backup') 
    const backupHost = result.hosts.find(h => h.slot === 'backup');
    expect(backupHost).toBeDefined();
    expect(backupHost!.matched).toBe('unknown');
    expect(backupHost!.online).toBe('unknown');
    expect(backupHost!.isSelf).toBe(false);
    expect(result.reasons.some(r => r.includes('matches 2 tailnet peers'))).toBe(true);
  });

  it('case 4: peer named unknown never matches alias unknown', () => {
    const config = { role:'primary', node:'n1', owner:'o1', primary:'mac-a', backup:'unknown' };
    const peers = {
      asOf: '2026-11-14T10:00:00Z',
      self: 'self-peer',
      peers: [
        { name: 'unknown', online: false, lastSeen: '2026-11-14T08:00:00Z', ageSeconds: 7200 }
      ],
      reasons: []
    };
    
    const result = joinPoolReach(config, null, peers, '');
    
    // Check the backup host (slot: 'backup') 
    const backupHost = result.hosts.find(h => h.slot === 'backup');
    expect(backupHost).toBeDefined();
    expect(backupHost!.matched).toBe('unknown');
    expect(backupHost!.online).toBe('unknown');
    expect(backupHost!.isSelf).toBe(false);
    expect(result.reasons.some(r => r.includes('no tailnet peer named'))).toBe(true);
  });

  it('case 5: when alias equals peers.self: isSelf true, online true, matched is self name', () => {
    const config = { role:'primary', node:'n1', owner:'o1', primary:'mac-a', backup:'mac-b' };
    const peers = {
      asOf: '2026-11-14T10:00:00Z',
      self: 'mac-b',
      peers: [
        { name: 'mac-b', online: false, lastSeen: '2026-11-14T08:00:00Z', ageSeconds: 7200 }
      ],
      reasons: []
    };
    
    const result = joinPoolReach(config, null, peers, '');
    
    // Check the backup host (slot: 'backup') 
    const backupHost = result.hosts.find(h => h.slot === 'backup');
    expect(backupHost).toBeDefined();
    expect(backupHost!.matched).toBe('mac-b');
    expect(backupHost!.online).toBe(true);
    expect(backupHost!.isSelf).toBe(true);
  });

  it('case 6: when configError is "boom /Users/fake/x": hosts empty, reason starts with "pool config:", home does not appear', () => {
    const config = null;
    const configError = 'boom /Users/fake/x';
    const peers = {
      asOf: '2026-11-14T10:00:00Z',
      self: 'self-peer',
      peers: [],
      reasons: []
    };
    
    const result = joinPoolReach(config, configError, peers, '/Users/fake');
    
    expect(result.hosts).toHaveLength(0);
    expect(result.reasons[0]).toContain('pool config:');
    expect(result.reasons[0]).not.toContain('/Users/fake');
  });

  it('case 7: when config is null: reasons include "node pool not configured"', () => {
    const config = null;
    const configError = null;
    const peers = {
      asOf: '2026-11-14T10:00:00Z',
      self: 'self-peer',
      peers: [],
      reasons: []
    };
    
    const result = joinPoolReach(config, configError, peers, '');
    
    expect(result.reasons.some(r => r.includes('node pool not configured'))).toBe(true);
  });
});
