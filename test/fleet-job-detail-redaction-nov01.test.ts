import { expect, it, vi } from 'vitest';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';

const files = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(async (path: string) => {
    const text = files.get(path);
    if (text === undefined) throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
    return { isFile: () => true, size: Buffer.byteLength(text), mtimeMs: 1 };
  }),
  open: vi.fn(async (path: string) => ({
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = Buffer.from(files.get(path)!).copy(buffer, offset, position, position + length);
      return { bytesRead };
    },
    close: async () => {},
  })),
}));

it('scrubs metadata and publish fields as strictly as tail lines before transport', async () => {
  const dir = '/example-runs';
  const job = 'RQ-EXAMPLE';
  files.set(`${dir}/${job}.base`, 'abcdef token=example-value /example-worktree');
  files.set(`${dir}/${job}.base.meta`, 'MODEL secret=example-value api_key=example-value authorization=example-value');
  files.set(`${dir}/${job}.publish`, 'RESULT PR bearer=example-value\nTEST secret=example-value\nSENS=[token=example-value]');
  files.set(`${dir}/${job}.log`, 'Working\nsecret=example-value\n/Users/example/project');
  const detail = await getFleetJobDetail(job, { runsDir: dir });
  expect(detail.branch).toBe('[redacted line]');
  expect([detail.lane, detail.tier, detail.model]).toEqual(Array(3).fill('[redacted line]'));
  expect(detail.publish?.testLine).toBe('[redacted line]');
  expect(detail.log.tail).toContain('[redacted line]');
  expect(JSON.stringify(detail)).not.toContain('example-value');
  expect(JSON.stringify(detail)).not.toContain('/Users/example');
});
