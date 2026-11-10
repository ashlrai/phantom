import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { inboxHeld } from './inbox-held-model.js';

const err = (status: number, body: unknown, detail: string | null = null) => new ApiError('x', status, '/p', detail, null, body);

describe('inboxHeld', () => {
  it('detects a 403 drafted body and keeps the server reason', () => {
    expect(inboxHeld(err(403, { ok: false, status: 'drafted', reason: 'R' }, 'R'))).toEqual({ held: true, reason: 'R' });
  });
  it('ignores other 403s, other statuses, missing bodies and non-ApiErrors', () => {
    expect(inboxHeld(err(403, { error: 'nope' }))).toBeNull();
    expect(inboxHeld(err(500, { status: 'drafted' }))).toBeNull();
    expect(inboxHeld(err(403, null))).toBeNull();
    expect(inboxHeld(new Error('x'))).toBeNull();
  });
  it('ApiError exposes the parsed body', () => {
    expect(err(403, { a: 1 }).body).toEqual({ a: 1 });
    expect(new ApiError('x', 500, '/p').body).toBeNull();
  });
});
