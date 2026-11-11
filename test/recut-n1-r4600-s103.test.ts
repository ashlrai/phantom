import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { sendJson } from '../src/core/web/api.js';

describe('nodes response serialization', () => {
  it('preserves a null error while bounding actual error text', () => {
    let payload = '';
    const response = {
      writeHead: () => {},
      end: (body: string) => { payload = body; },
    } as unknown as ServerResponse;

    sendJson(response, 200, { error: null });
    expect(JSON.parse(payload)).toEqual({ error: null });
    sendJson(response, 200, { error: 'x'.repeat(600) });
    expect(JSON.parse(payload).error).toHaveLength(512);
  });
});
