import { describe, expect, it } from 'vitest';
import { readZaiUsage, ZAI_USAGE_SOURCE } from '../src/core/usage/zai-usage.js';

const MTIME = Date.parse('2026-11-09T06:00:00.000Z');
const deps = (body: string | Error) => ({
  runsDir: '/fixture/runs',
  readText: async (path: string) => {
    expect(path).toBe('/fixture/runs/queue/resources.json');
    if (body instanceof Error) throw body;
    return body;
  },
  mtimeMs: async () => MTIME,
});

describe('readZaiUsage', () => {
  it('projects the zai row of resources.json as a percent reading', async () => {
    const body = JSON.stringify({ zai: { used_frac: 0.375, reset_at: '2026-11-09T11:00:00Z' }, claude: { used_frac: 0.9 } });
    expect(await readZaiUsage(deps(body))).toEqual({
      used: 37.5, limit: 100, unit: 'percent', resetsAt: '2026-11-09T11:00:00.000Z',
      source: ZAI_USAGE_SOURCE, asOf: '2026-11-09T06:00:00.000Z',
    });
  });

  it('accepts the lanes wrapper and epoch-second resets, and caps used at the window', async () => {
    const body = JSON.stringify({ lanes: { zai: { used_frac: 1.4, reset_at: 1_793_000_000 } } });
    expect(await readZaiUsage(deps(body))).toMatchObject({ used: 100, resetsAt: new Date(1_793_000_000_000).toISOString() });
  });

  it.each([
    ['no zai row', JSON.stringify({ claude: { used_frac: 0.1 } })],
    ['no used_frac', JSON.stringify({ zai: { reset_at: '2026-11-09T11:00:00Z' } })],
    ['negative used_frac', JSON.stringify({ zai: { used_frac: -1 } })],
    ['string used_frac', JSON.stringify({ zai: { used_frac: '0.5' } })],
    ['non-object file', '[]'],
    ['bad json', '{nope'],
  ])('reads %s as no reading, never 0%', async (_name, body) => {
    expect(await readZaiUsage(deps(body))).toBeNull();
  });

  it('reads a missing file as no reading', async () => {
    expect(await readZaiUsage(deps(Object.assign(new Error('x'), { code: 'ENOENT' })))).toBeNull();
  });

  it('keeps a null reset when reset_at is unusable', async () => {
    const body = JSON.stringify({ zai: { used_frac: 0.5, reset_at: 'soon' } });
    expect(await readZaiUsage(deps(body))).toMatchObject({ used: 50, resetsAt: null });
  });
});
