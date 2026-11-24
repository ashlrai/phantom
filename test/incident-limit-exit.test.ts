import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyExit, EXIT_CLASS_SCHEMA } from '../src/core/fleet/incident-exit.js';
import { ingestSignal, type IncidentDeps, type IncidentSignal } from '../src/core/incident/pipeline.js';
import { QueueStore } from '../src/core/queue/store.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');

describe('classifyExit', () => {
  it('reports a plan-limit exit with its parsed reset time and is not fixable', () => {
    const r = classifyExit({ exitCode: 1, nowMs: NOW, text: "You've hit your usage limit. Try again at Nov 19th, 2026 1:41 AM." });
    expect(r).toMatchObject({ v: 1, schema: EXIT_CLASS_SCHEMA, kind: 'plan-limit', exitCode: 1, fixable: false });
    expect(r.resetAt).toMatch(/^2026-11-19T01:41/);
  });
  it('reads a relative reset against the injected clock', () => {
    const r = classifyExit({ exitCode: 1, nowMs: NOW, text: 'usage limit reached, resets in 2 hours 30 minutes' });
    expect(r).toMatchObject({ kind: 'plan-limit', resetAt: '2026-11-18T14:30:00.000Z' });
  });
  it('keeps a limit with no advertised reset as plan-limit with a null reset', () => {
    expect(classifyExit({ exitCode: 0, nowMs: NOW, text: 'out of credits' })).toMatchObject({ kind: 'plan-limit', resetAt: null, fixable: false });
  });
  it('limit evidence wins over crash words and exit code 0', () => {
    expect(classifyExit({ exitCode: 139, nowMs: NOW, text: 'unhandled exception: usage limit' }).kind).toBe('plan-limit');
  });
  it('treats a real crash as the one fixable kind', () => {
    expect(classifyExit({ exitCode: 1, nowMs: NOW, text: 'TypeError: uncaught exception at foo.ts:3' })).toMatchObject({ kind: 'crash', fixable: true, resetAt: null });
  });
  it('does not call a clean exit with crash words a crash', () => {
    expect(classifyExit({ exitCode: 0, nowMs: NOW, text: 'handled exception in test' }).kind).toBe('unknown');
  });
  it('leaves unexplained exits unknown and unfixable', () => {
    for (const e of [{ exitCode: 2, text: 'exited' }, { exitCode: null, text: '' }, { nowMs: NOW }, { exitCode: Number.NaN, text: 'x' }]) {
      expect(classifyExit({ nowMs: NOW, ...e })).toMatchObject({ kind: 'unknown', fixable: false, resetAt: null });
    }
  });
  it('is typed JSON that round-trips', () => {
    const r = classifyExit({ exitCode: 1, nowMs: NOW, text: 'usage limit' });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe('incident ingest on exits', () => {
  let root: string, store: QueueStore, deps: IncidentDeps;
  const sig = (over: Partial<IncidentSignal>): IncidentSignal =>
    ({ kind: 'error', source: 'runner', repo: 'ashlrai/phantom', message: 'x', ...over });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'inc-limit-'));
    store = new QueueStore(join(root, 'queue'));
    deps = { store, dir: join(root, 'incidents'), now: () => NOW };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('queues no fix job for a plan-limit exit and returns the reset time', async () => {
    const r = await ingestSignal(sig({ exitCode: 1, severity: 'sev1', message: 'usage limit. try again at Nov 19, 2026 1:41 AM' }), deps);
    expect(r).toMatchObject({ status: 'plan-limit' });
    expect((r as { resetAt: string }).resetAt).toMatch(/^2026-11-19T01:41/);
    expect((await store.read()).jobs).toHaveLength(0);
  });
  it('still queues a fix job for a real crash', async () => {
    expect(await ingestSignal(sig({ exitCode: 1, message: 'uncaught exception in writer' }), deps)).toMatchObject({ status: 'enqueued' });
    expect((await store.read()).jobs).toHaveLength(1);
  });
  it('keeps the existing path for an unknown exit', async () => {
    expect((await ingestSignal(sig({ exitCode: 3, message: 'weird exit' }), deps)).status).toBe('enqueued');
  });
  it('rejects a non-integer exit code', async () => {
    expect(await ingestSignal(sig({ exitCode: 1.5 }), deps)).toEqual({ status: 'invalid', reason: 'invalid exit code' });
  });
});
