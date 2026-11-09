import { readFileSync, statSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const png = Buffer.from('png-bytes');
const secret = ['sk', 'ant', 'api03', 'B'.repeat(40)].join('-');

vi.mock('../src/core/desktop/operator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/desktop/operator.js')>();
  return {
    ...actual,
    runDesktopOperator: vi.fn(async () => ({
      ok: true,
      verb: 'screenshot',
      data: { app: 'Phantom', mime: 'image/png', base64: png.toString('base64'), width: 10, height: 8, ocrText: `seen ${secret}`, untrusted: true },
    })),
  };
});

import { desktopOperatorTools } from '../src/core/desktop/operator-mcp.js';

const shot = desktopOperatorTools.find((tool) => tool.name === 'desktop_screenshot')!;
const cfg = {} as never;

describe('desktop_screenshot MCP tool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a local 0600 path and scrubbed OCR, never image bytes, by default', async () => {
    const result = (await shot.handler({ app: 'Cursor' }, cfg)) as { ok: boolean; data: Record<string, unknown> };
    expect(result.ok).toBe(true);
    const path = result.data['path'] as string;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path).equals(png)).toBe(true);
    expect(result.data['base64']).toBeUndefined();
    const json = JSON.stringify(result);
    expect(json).not.toContain(png.toString('base64'));
    expect(json).not.toContain(secret);
    expect(result.data['ocrText']).toContain('[REDACTED]');
  });

  it('never returns Phantom pixels even with a legacy argument', async () => {
    const result = await shot.handler({ app: 'Phantom', include_image: true }, cfg);
    expect(JSON.stringify(result)).not.toContain(png.toString('base64'));
    expect(JSON.stringify(shot.inputSchema)).not.toContain('include_image');
  });
});
