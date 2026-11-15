import { describe, expect, it } from 'vitest';
import { ApiError, DispatchDisabledError } from '../../../data/client.js';
import { describeContextError } from './use-token-gate.js';

const NO_ROUTE = 'This server does not have that route yet — update Phantom and restart `ashlr verse`.';

describe('describeContextError with bare refusal bodies', () => {
  it('answers a 404 whose detail is just "not found" with the missing-route sentence', () => {
    expect(describeContextError(new ApiError('GET /x failed (HTTP 404)', 404, '/x', 'not found'))).toBe(NO_ROUTE);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(describeContextError(new ApiError('GET /x failed (HTTP 404)', 404, '/x', ' Not Found '))).toBe(NO_ROUTE);
  });

  it('keeps a real detail', () => {
    const detail = 'Run 7 is gone; it finished at 2026-11-09T10:00:00Z';
    const out = describeContextError(new ApiError('GET /x failed (HTTP 404)', 404, '/x', detail));
    expect(out).not.toBe(NO_ROUTE);
    expect(out).toContain('Run 7 is gone; it finished at');
  });

  it('answers a 409 with no detail with the busy-chat sentence', () => {
    expect(describeContextError(new ApiError('POST /x failed (HTTP 409)', 409, '/x'))).toBe(
      'A turn is already running in this chat. Wait for it or stop it first.',
    );
  });

  it('leaves the dispatch and missing-chat sentences unchanged', () => {
    expect(describeContextError(new DispatchDisabledError('/x'))).toBe(
      'This server is read-only (started without dispatch — run `ashlr verse`), or older than this console.',
    );
    expect(
      describeContextError(new ApiError('failed', 404, '/x', 'session not found: vs_gone', 'VERSE_SESSION_NOT_FOUND')),
    ).toBe('This chat no longer exists on the server — it may have been deleted. Refresh the chat list.');
  });
});
