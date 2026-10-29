import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const { runModelcapsNightly } = await import('../scripts/modelcaps-nightly.mjs');

afterEach(() => vi.resetAllMocks());

describe('nightly modelcaps runner', () => {
  it('runs a fixed source worker under Phantom Secrets without a shell or forwarded output', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    expect(runModelcapsNightly(['--provider', 'fixture', '--output', '/private/cache path/models.json'])).toBe(0);
    const [bin, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
    expect(bin).toBe('phantom');
    expect(args!.slice(0, 5)).toEqual(['exec', '--', process.execPath, '--import', expect.stringContaining('tsx')]);
    expect(args![5]).toMatch(/[/\\]src[/\\]core[/\\]modelcaps\.ts$/);
    expect(args!.slice(6)).toEqual(['--provider', 'fixture', '--output', '/private/cache path/models.json']);
    expect(options).toEqual({ stdio: 'ignore', shell: false, timeout: 60_000 });
  });

  it.each([
    { status: 1 },
    { status: null, signal: 'SIGTERM' },
    { status: null, error: new Error('fixture transport detail must stay private') },
    { status: 0, error: new Error('fixture failed launch') },
  ])('reports a failed wrapper instead of claiming a refreshed cache: %j', result => {
    vi.mocked(spawnSync).mockReturnValue(result as ReturnType<typeof spawnSync>);
    expect(runModelcapsNightly(['--provider', 'fixture'])).toBe(1);
  });
});
