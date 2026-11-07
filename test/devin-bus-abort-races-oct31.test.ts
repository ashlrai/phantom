/** Cancellation races use only a local fake executable and fabricated data. */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  afterOpen: undefined as undefined | (() => Promise<void>),
  afterWrite: undefined as undefined | ((path: string) => void),
  beforeRemove: undefined as undefined | ((path: string) => void),
}));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      await hooks.afterOpen?.();
      return file;
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args);
      hooks.afterWrite?.(String(args[0]));
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      hooks.beforeRemove?.(String(args[0]));
      await fs.rm(...args);
    },
  };
});

import { runDevinBusAdapter, type DevinBusAdapterDeps, type DevinBusRequest } from '../src/core/fleet/bus-adapters/devin.js';

let dir: string;
let request: DevinBusRequest;
let marker: string;
let script: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devin-abort-races-'));
  marker = join(dir, 'started');
  script = join(dir, 'fake.cjs');
  request = { inboxPath: join(dir, 'inbox'), outboxPath: join(dir, 'outbox'), cwd: dir, timeoutMs: 10000 };
  writeFileSync(request.inboxPath, 'fake inbox');
  writeFileSync(request.outboxPath, 'previous reply');
});

afterEach(() => {
  hooks.afterOpen = undefined;
  hooks.afterWrite = undefined;
  hooks.beforeRemove = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function fake(source: string, check = (): void => {}): DevinBusAdapterDeps {
  writeFileSync(script, source);
  return { authorize: async () => ({ command: [process.execPath, script, marker], check }) };
}
function unchanged(): void {
  expect(readFileSync(request.outboxPath, 'utf8')).toBe('previous reply');
  expect(readdirSync(dir).filter(name => name.startsWith('.phantom-devin-bus-') || name.startsWith('.devin-reply-'))).toEqual([]);
}
async function started(): Promise<number> {
  await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 2000, interval: 10 });
  return Number(readFileSync(marker, 'utf8'));
}
const startMarker = "require('node:fs').writeFileSync(process.argv[2], String(process.pid));";

describe('Devin bus cancellation boundaries', () => {
  it('does not authorize or launch pre-aborted input', async () => {
    const controller = new AbortController();
    controller.abort();
    const authorize = vi.fn(fake(`${startMarker} process.stdout.write('reply');`).authorize);
    await expect(runDevinBusAdapter({ ...request, signal: controller.signal }, { authorize })).rejects.toMatchObject({ code: 'cancelled' });
    expect(authorize).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    unchanged();
  });

  it('does not launch when authorization resolves after cancellation', async () => {
    const controller = new AbortController();
    const engine = fake(`${startMarker} process.stdout.write('reply');`);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const authorize: DevinBusAdapterDeps['authorize'] = async (...args) => {
      entered();
      await waiting;
      return engine.authorize(...args);
    };
    const pending = runDevinBusAdapter({ ...request, signal: controller.signal }, { authorize });
    await ready;
    controller.abort();
    release();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(existsSync(marker)).toBe(false);
    unchanged();
  });

  it('does not authorize after cancellation during asynchronous inbox opening', async () => {
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    hooks.afterOpen = async () => { entered(); await waiting; };
    const authorize = vi.fn(fake(`${startMarker} process.stdout.write('reply');`).authorize);
    const pending = runDevinBusAdapter({ ...request, signal: controller.signal }, { authorize });
    await ready;
    controller.abort();
    release();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(authorize).not.toHaveBeenCalled();
    unchanged();
  });

  it('kills and reaps a silent child on cancellation', async () => {
    const controller = new AbortController();
    const pending = runDevinBusAdapter({ ...request, signal: controller.signal }, fake(`${startMarker} setInterval(() => {}, 1000);`));
    const pid = await started();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(() => process.kill(pid, 0)).toThrow();
    unchanged();
  });

  it('cancels after leader exit while child close is waiting for inherited output', async () => {
    const controller = new AbortController();
    const source = `${startMarker}
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], {stdio: ['ignore', 'inherit', 'inherit']}).unref();
      process.stdout.write('stale reply');`;
    const pending = expect(runDevinBusAdapter({ ...request, signal: controller.signal }, fake(source))).rejects.toMatchObject({ code: 'cancelled' });
    const pid = await started();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000, interval: 10 });
    controller.abort();
    await pending;
    unchanged();
  });

  it('removes staged output when cancelled before the atomic rename', async () => {
    const controller = new AbortController();
    hooks.afterWrite = path => { if (path.includes('.devin-reply-')) controller.abort(); };
    await expect(runDevinBusAdapter({ ...request, signal: controller.signal }, fake("process.stdout.write('reply');")))
      .rejects.toMatchObject({ code: 'cancelled' });
    unchanged();
  });

  it('keeps a completed atomic publication when cancelled during cleanup', async () => {
    const controller = new AbortController();
    hooks.beforeRemove = path => { if (path.includes('.phantom-devin-bus-')) controller.abort(); };
    const result = await runDevinBusAdapter({ ...request, signal: controller.signal }, fake("process.stdout.write('complete reply');"));
    expect(controller.signal.aborted).toBe(true);
    expect(result.bytes).toBe(Buffer.byteLength('complete reply'));
    expect(readFileSync(request.outboxPath, 'utf8')).toBe('complete reply');
    expect(readdirSync(dir).filter(name => name.startsWith('.phantom-devin-bus-') || name.startsWith('.devin-reply-'))).toEqual([]);
  });

  it('rechecks admission and never exposes fake secrets in failures', async () => {
    const secret = ['ghp', 'FAKE' + 'x'.repeat(40)].join('_');
    const check = vi.fn(() => { throw new Error(secret); });
    const failure = await runDevinBusAdapter(request, fake(`${startMarker} process.stdout.write('reply');`, check)).catch(error => error);
    expect(check).toHaveBeenCalledOnce();
    expect(failure).toMatchObject({ code: 'admission', message: 'Devin bus adapter: admission.' });
    expect(String(failure)).not.toContain(secret);
    expect(existsSync(marker)).toBe(false);
    const outputFailure = await runDevinBusAdapter(request, fake(`process.stdout.write(${JSON.stringify(secret)}); process.stderr.write(${JSON.stringify(secret)}); process.exitCode = 1;`)).catch(error => error);
    expect(outputFailure).toMatchObject({ code: 'failed', message: 'Devin bus adapter: failed.' });
    expect(String(outputFailure)).not.toContain(secret);
    unchanged();
  });
});
