import { describe, expect, it } from 'vitest';
import { classifyRemoteRoute, validateRemoteMutation } from './remote-gateway-policy.js';

const bus = '/api/verse/agent-bus';
const drop = '/api/verse/fleet/live/drop-jobs';

describe('phone gateway agent bus and drop jobs', () => {
  it('allows the reviewed reads and bounded bus query shapes', () => {
    for (const target of [bus, `${bus}?after=0`, `${bus}?after=999999999999`, `${bus}?limit=1`,
      `${bus}?limit=200`, `${bus}?after=42&limit=50`, `${bus}?limit=50&after=42`]) {
      expect(classifyRemoteRoute('GET', target), target).toEqual({ kind: 'read', path: bus });
    }
    expect(classifyRemoteRoute('GET', drop)).toEqual({ kind: 'read', path: drop });
  });

  it('classifies writes with the required step-up and validates their bodies', () => {
    const job = classifyRemoteRoute('POST', drop);
    const message = classifyRemoteRoute('POST', bus);
    expect(job).toEqual({ kind: 'write', path: drop, stepUp: true });
    expect(message).toEqual({ kind: 'write', path: bus, stepUp: false });
    const jobBody = { id: 'EXAMPLE123', lane: 'claude', tier: 'work', body: 'Inspect the example.' };
    const envelope = { id: 'example-1', from: 'mason', to: 'fleet', priority: 'P0', ttl: 1000,
      body: { kind: 'interjection', text: 'Please inspect.' } };
    expect(validateRemoteMutation(job, jobBody)).toBe(true);
    expect(validateRemoteMutation(message, envelope)).toBe(true);
    for (const body of [{ ...jobBody, extra: true }, { ...jobBody, id: '../bad' }, { ...jobBody, lane: 'unknown' }, {}]) {
      expect(validateRemoteMutation(job, body)).toBe(false);
    }
    for (const body of [{ ...envelope, extra: true }, { ...envelope, ttl: 0 }, { ...envelope, priority: 'urgent' }, {}]) {
      expect(validateRemoteMutation(message, body)).toBe(false);
    }
  });

  it('denies unreviewed methods, paths and queries', () => {
    for (const target of [`${bus}?after=abc`, `${bus}?after=1234567890123`, `${bus}?after=`,
      `${bus}?after=1%0a`, `${bus}?limit=0`, `${bus}?limit=201`, `${bus}?limit=abc`,
      `${bus}?limit=1%0a`, `${bus}?after=1&extra=1`, `${bus}?after=1&after=2`,
      `${bus}?limit=1&limit=2`, `${bus}?`, `${bus}/`, `${bus}/../fleet`, '//api/verse/agent-bus',
      `${drop}?limit=1`]) {
      expect(classifyRemoteRoute('GET', target), target).toEqual({ kind: 'deny' });
    }
    for (const path of [bus, drop]) {
      expect(classifyRemoteRoute('POST', `${path}?x=1`)).toEqual({ kind: 'deny' });
      expect(classifyRemoteRoute('DELETE', path)).toEqual({ kind: 'deny' });
    }
  });

  it('retains existing denials outside the new routes', () => {
    for (const target of ['/api/verse/terminal', '/api/verse/activity?x=1', '/api/verse/../activity']) {
      expect(classifyRemoteRoute('GET', target), target).toEqual({ kind: 'deny' });
    }
  });
});
