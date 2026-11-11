import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { handleApi } from '../src/core/web/api.js';

describe('ideas draft API dispatch', () => {
  it.each([['GET', true], ['POST', false]] as const)(
    'refuses %s when dispatch is %s', async (method, allowDispatch) => {
      const req = new EventEmitter() as IncomingMessage;
      req.method = method;
      req.url = '/api/ideas/draft';
      req.headers = {};
      let status = 0;
      const res = {
        writeHead(code: number) { status = code; },
        end() {},
      } as unknown as ServerResponse;
      expect(await handleApi(req, res, {} as AshlrConfig, { token: 'test-token', allowDispatch })).toBe(true);
      expect(status).toBe(404);
    },
  );
});
