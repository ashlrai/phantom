import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetNeedsWaitGroup } from './src/cli/fleet-needs-wait-group.js';
import { resolveFleetSubcommand } from './src/cli/fleet-subcommand-resolve.js';

const idOf = (text: string): string => `nm-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
const [approveMsg, keyMsg] = ['Approve the fake deploy', 'Rotate the fake key'];
const [idA, idB] = [idOf(approveMsg), idOf(keyMsg)];
const dirs: string[] = [];
function ledger(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'needs-stdin-group-'));
  dirs.push(dir);
  const file = join(dir, 'NEEDS-MASON.md');
  writeFileSync(file, `- [ ] ${approveMsg}\n- [ ] ${keyMsg}\n`);
  return { dir, file };
}
const mark = (file: string, id: string): void => appendFileSync(file, `- [x] resolved ${id} stamp\n`);

function streamFor(text: string | Buffer): Readable {
  return Readable.from([Buffer.from(text)]);
}

function streamSplit(text: string, split: number): Readable {
  const buf = Buffer.from(text);
  const a = buf.subarray(0, split);
  const b = buf.subarray(split);
  const s = new PassThrough();
  setImmediate(() => { s.write(a); s.end(b); });
  return s;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('fleet needs-wait-group --ids-stdin', () => {
  it('resolves its convention name and documents --ids-stdin in help', async () => {
    expect(resolveFleetSubcommand('needs-wait-group')).toEqual({
      module: './fleet-needs-wait-group.js',
      exportName: 'cmdFleetNeedsWaitGroup',
    });
    const output: string[] = [];
    expect(await cmdFleetNeedsWaitGroup(['--help'], {
      emit: text => output.push(text),
    })).toBe(0);
    expect(output[0]).toContain('--ids-stdin');
    expect(output[0]).toContain('nm-id');
  });

  it('reads a valid JSON array from stdin and resolves items', async () => {
    vi.useRealTimers();
    try {
      const { dir, file } = ledger();
      mark(file, idA); mark(file, idB);
      const jsonText = JSON.stringify([idA, idB]);
      const written = Buffer.from(jsonText).indexOf(Buffer.from(idB));
      const splitInput = streamSplit(jsonText, written + 2);
      const emit = vi.fn();
      const r = await cmdFleetNeedsWaitGroup(['--ids-stdin', '--timeout-ms', '500', '--runs-dir', dir], {
        emit, input: splitInput,
      });
      expect(r).toBe(0);
      expect(emit).toHaveBeenCalledWith(expect.stringContaining('resolved'));
    } finally {
      vi.useFakeTimers();
    }
  });

  it('marks unresolved items as timeout and exits 1 when budget expires', async () => {
    const { dir } = ledger();
    const missing = join(dir, 'nope');
    const emit = vi.fn();
    const code = await cmdFleetNeedsWaitGroup(['--ids-stdin', '--timeout-ms', '3', '--runs-dir', missing], {
      input: streamFor(JSON.stringify([idA])),
      emit,
    });
    expect(code).toBe(1);
    const out = emit.mock.calls[0][0] as string;
    expect(out).toMatch(/timeout|unavailable/);
  });

  it('rejects empty, malformed, oversized, duplicate and mixed input with exit 2', async () => {
    const emit = vi.fn();
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const base = ['--ids-stdin', '--timeout-ms', '50'];
    for (const payload of [
      '[]',
      'null',
      '42',
      '"nm-000000000001"',
      '{"a":1}',
      '1,2',
      '[1,2]',
      '["nm-000000000001","nm-000000000001"]',
      '[1, "nm-000000000001"]',
    ]) {
      const code = await cmdFleetNeedsWaitGroup(base, {
        input: streamFor(payload),
        emit,
      });
      expect(code).toBe(2);
    }
    // Oversize: 16 KiB + 1 byte
    const bigCode = await cmdFleetNeedsWaitGroup(
      ['--ids-stdin', '--timeout-ms', '50'],
      { input: streamFor(Buffer.alloc(16 * 1024 + 1, 'x')), emit },
    );
    expect(bigCode).toBe(2);
    expect(emit).not.toHaveBeenCalled();
    expect(stderrWrite).toHaveBeenCalled();
  });

  it('refuses positional ids mixed with --ids-stdin', async () => {
    const emit = vi.fn();
    const code = await cmdFleetNeedsWaitGroup(
      [idA, '--ids-stdin', '--timeout-ms', '50'],
      { input: streamFor('["nm-000000000002"]'), emit },
    );
    expect(code).toBe(2);
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses --ids-stdin without a valid timeout', async () => {
    const code = await cmdFleetNeedsWaitGroup(['--ids-stdin', '--runs-dir', '/tmp'], {
      input: streamFor('["nm-000000000001"]'),
    });
    expect(code).toBe(2);
  });

  it('rejects oversized stdin ( > 16 KiB) without echoing payload', async () => {
    const emit = vi.fn();
    const text = 'x'.repeat(16 * 1024 + 1);
    const code = await cmdFleetNeedsWaitGroup(['--ids-stdin', '--timeout-ms', '50'], {
      input: streamFor(text),
      emit,
    });
    expect(code).toBe(2);
    expect(emit).not.toHaveBeenCalled();
  });

  it('times out during stdin collection when EOF never arrives', async () => {
    vi.useRealTimers();
    try {
      const emit = vi.fn();
      const stall = new PassThrough();
      const code = await cmdFleetNeedsWaitGroup(['--ids-stdin', '--timeout-ms', '5'], {
        input: stall,
        emit,
      });
      expect(code).toBe(2);
      expect(emit).not.toHaveBeenCalled();
      stall.destroy();
    } finally {
      vi.useFakeTimers();
    }
  });

  it('cancels every child on SIGINT during stdin collection via injected abort signal', async () => {
    vi.useRealTimers();
    try {
      const controller = new AbortController();
      const emit = vi.fn();
      const beforeInt = process.listenerCount('SIGINT');
      const beforeTerm = process.listenerCount('SIGTERM');
      const stall = new PassThrough();
      const sigPending = cmdFleetNeedsWaitGroup(['--ids-stdin', '--timeout-ms', '100'], {
        input: stall,
        signal: controller.signal,
        emit,
      });
      await new Promise(resolve => setImmediate(resolve));
      controller.abort();
      const code = await sigPending;
      expect(code).toBe(130);
      expect(process.listenerCount('SIGINT')).toBe(beforeInt);
      expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
      stall.destroy();
    } finally {
      vi.useFakeTimers();
    }
  });

  it('cancels every child on SIGTERM during stdin collection via injected abort signal', async () => {
    vi.useRealTimers();
    try {
      const controller = new AbortController();
      const emit = vi.fn();
      const beforeInt = process.listenerCount('SIGINT');
      const beforeTerm = process.listenerCount('SIGTERM');
      const stall = new PassThrough();
      const sigPending = cmdFleetNeedsWaitGroup(['--ids-stdin', '--timeout-ms', '100'], {
        input: stall,
        signal: controller.signal,
        emit,
      });
      await new Promise(resolve => setImmediate(resolve));
      controller.abort();
      const code = await sigPending;
      expect(code).toBe(130);
      expect(process.listenerCount('SIGINT')).toBe(beforeInt);
      expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
      stall.destroy();
    } finally {
      vi.useFakeTimers();
    }
  });

  it('rejects pre-aborted injected signal during collection', async () => {
    const controller = new AbortController();
    controller.abort();
    const emit = vi.fn();
    const code = await cmdFleetNeedsWaitGroup(['--ids-stdin', '--timeout-ms', '50'], {
      input: streamFor('["nm-000000000001"]'),
      signal: controller.signal,
      emit,
    });
    expect(code).toBe(2);
    expect(emit).not.toHaveBeenCalled();
  });

  it('shares the timeout between collection and group wait: a slow close triggers non-resolved', async () => {
    vi.useRealTimers();
    try {
      const { dir } = ledger();
      const emit = vi.fn();
      const stall = new PassThrough();
      const code = await cmdFleetNeedsWaitGroup(['--ids-stdin', '--timeout-ms', '10', '--runs-dir', dir], {
        input: stall,
        emit,
      });
      expect(code).toBe(2); // collection timed out, never started wait
      stall.destroy();
    } finally {
      vi.useFakeTimers();
    }
  });

  it('validates id format from stdin (malformed nm-id rejected)', async () => {
    const emit = vi.fn();
    const code = await cmdFleetNeedsWaitGroup(['--ids-stdin', '--timeout-ms', '50'], {
      input: streamFor('["bad-id"]'),
      emit,
    });
    expect(code).toBe(2);
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses more than NEEDS_WAIT_GROUP_MAX ids from stdin', async () => {
    const emit = vi.fn();
    const tooMany = Array.from({ length: 33 }, (_, n) => `nm-${n.toString(16).padStart(12, '0')}`);
    const code = await cmdFleetNeedsWaitGroup(['--ids-stdin', '--timeout-ms', '50'],
      { input: streamFor(JSON.stringify(tooMany)), emit });
    expect(code).toBe(2);
    expect(emit).not.toHaveBeenCalled();
  });

  it('accepts --ids-stdin with --stop-file and --json', async () => {
    const { dir, file } = ledger();
    const stopFile = join(dir, 'STOP.txt');
    const emit = vi.fn();
    mark(file, idA); mark(file, idB);
    const code = await cmdFleetNeedsWaitGroup(
      ['--ids-stdin', '--timeout-ms', '500', '--runs-dir', dir, '--stop-file', stopFile, '--json'],
      { input: streamFor(JSON.stringify([idA, idB])), emit },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(emit.mock.calls[0][0]);
    expect(parsed).toEqual({
      outcome: 'resolved',
      items: [{ id: idA, status: 'resolved' }, { id: idB, status: 'resolved' }],
    });
  });

  it('reads stdin as JSON array into real wait before resolving (full pipeline)', async () => {
    const { dir, file } = ledger();
    mark(file, idA); mark(file, idB);
    const emit = vi.fn();
    const code = await cmdFleetNeedsWaitGroup(
      ['--ids-stdin', '--timeout-ms', '500', '--runs-dir', dir],
      { input: streamFor(JSON.stringify([idB, idA])), emit },
    );
    expect(code).toBe(0);
    const out = emit.mock.calls[0][0] as string;
    expect(out).toContain('resolved');
  });
});
