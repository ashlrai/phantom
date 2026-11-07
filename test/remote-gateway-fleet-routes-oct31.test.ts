import { describe, expect, it } from 'vitest';
import { classifyRemoteRoute, validateRemoteMutation } from '../src/core/web/remote-gateway-policy.js';

describe('remote gateway fleet routes for the paired phone', () => {
  it('reads live runs, inbox, bus, queue, switches and lanes', () => {
    for (const [target, path] of [
      ['/api/verse/fleet/runs', '/api/verse/fleet/runs'],
      ['/api/verse/fleet/runs/inbox?limit=50', '/api/verse/fleet/runs/inbox'],
      ['/api/verse/fleet/runs/inbox?limit=1', '/api/verse/fleet/runs/inbox'],
      ['/api/verse/fleet/runs/inbox?limit=200', '/api/verse/fleet/runs/inbox'],
      ['/api/verse/fleet/runs/inbox?limit=100&source=Phantom%20mobile', '/api/verse/fleet/runs/inbox'],
      ['/api/verse/fleet/live/bus', '/api/verse/fleet/live/bus'],
      ['/api/verse/fleet/live/bus?limit=20', '/api/verse/fleet/live/bus'],
      ['/api/verse/fleet/live/bus?limit=50', '/api/verse/fleet/live/bus'],
      ['/api/verse/fleet/live/queue', '/api/verse/fleet/live/queue'],
      ['/api/verse/fleet/live/queue?limit=25', '/api/verse/fleet/live/queue'],
      ['/api/verse/fleet/control/switches', '/api/verse/fleet/control/switches'],
      ['/api/verse/fleet/control/lanes', '/api/verse/fleet/control/lanes'],
    ] as const) expect(classifyRemoteRoute('GET', target)).toEqual({ kind: 'read', path });
  });

  it('denies out-of-shape fleet read queries and unreviewed fleet paths', () => {
    for (const target of [
      '/api/verse/fleet/runs/inbox?limit=0',
      '/api/verse/fleet/runs/inbox?limit=201',
      '/api/verse/fleet/runs/inbox?limit=1e2',
      '/api/verse/fleet/runs/inbox?limit=50&source=a/b',
      '/api/verse/fleet/runs/inbox?limit=50&x=1',
      '/api/verse/fleet/runs/inbox?limit=50&limit=60',
      '/api/verse/fleet/runs/inbox',
      '/api/verse/fleet/runs?limit=10',
      '/api/verse/fleet/live/bus?limit=0',
      '/api/verse/fleet/live/bus?limit=20&source=x',
      '/api/verse/fleet/live/queue?limit=201',
      '/api/verse/fleet/control/switches?limit=1',
      '/api/verse/fleet/control',
    ]) expect(classifyRemoteRoute('GET', target)).toEqual({ kind: 'deny' });
  });

  it('posts an inbox interjection without step-up and validates the exact body', () => {
    const inbox = classifyRemoteRoute('POST', '/api/verse/fleet/runs/inbox');
    expect(inbox).toEqual({ kind: 'write', path: '/api/verse/fleet/runs/inbox', stepUp: false });
    expect(validateRemoteMutation(inbox, { text: 'go' })).toBe(true);
    expect(validateRemoteMutation(inbox, { text: 'go', source: 'Phantom mobile' })).toBe(true);
    expect(validateRemoteMutation(inbox, { text: '  ' })).toBe(false);
    expect(validateRemoteMutation(inbox, { text: 'go', extra: 1 })).toBe(false);
    expect(validateRemoteMutation(inbox, { text: 'go', source: 'a/b' })).toBe(false);
  });

  it('keeps switch flips and lane targets behind step-up with exact bodies', () => {
    const switches = classifyRemoteRoute('POST', '/api/verse/fleet/control/switches');
    expect(switches).toEqual({ kind: 'write', path: '/api/verse/fleet/control/switches', stepUp: true });
    expect(validateRemoteMutation(switches, { id: 'pause-dispatch', on: true })).toBe(true);
    expect(validateRemoteMutation(switches, { id: 'PAUSE', on: false })).toBe(true);
    expect(validateRemoteMutation(switches, { id: 'x;rm', on: 'yes' })).toBe(false);
    expect(validateRemoteMutation(switches, { id: 'PAUSE' })).toBe(false);
    expect(validateRemoteMutation(switches, { id: 'PAUSE', on: true, extra: 1 })).toBe(false);

    const lanes = classifyRemoteRoute('POST', '/api/verse/fleet/control/lanes');
    expect(lanes).toEqual({ kind: 'write', path: '/api/verse/fleet/control/lanes', stepUp: true });
    expect(validateRemoteMutation(lanes, { lane: 'codex-personal', target: 24 })).toBe(true);
    for (const target of [65, -1, 1.5]) {
      expect(validateRemoteMutation(lanes, { lane: 'codex-personal', target })).toBe(false);
    }
    expect(validateRemoteMutation(lanes, { lane: 'Codex_Personal', target: 1 })).toBe(false);
  });

  it('denies DELETE on every newly reviewed fleet route', () => {
    for (const path of [
      '/api/verse/fleet/runs', '/api/verse/fleet/runs/inbox',
      '/api/verse/fleet/live/bus', '/api/verse/fleet/live/queue',
      '/api/verse/fleet/control/switches', '/api/verse/fleet/control/lanes',
    ]) expect(classifyRemoteRoute('DELETE', path)).toEqual({ kind: 'deny' });
  });
});
