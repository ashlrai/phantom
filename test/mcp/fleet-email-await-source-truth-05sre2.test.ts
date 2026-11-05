import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMAIL_DROP_CONFIG_FILE } from '../../src/core/comms/email-drop-config.js';
import { readFleetEmailOutboxAwait, parseFleetEmailOutboxAwaitArgs } from '../../src/mcp/fleet-email-outbox-await.js';

const name = 'artifact.reply.eml';
let root: string;
let validConfigPath: string;

function makeFakeConfig(): ReturnType<typeof import('../../src/core/comms/email-drop-config.js').readEmailDropConfig> {
  return { state: 'ok', config: { v: 1, inboxDir: join(root, 'inbox'), from: ['owner@example.test'] }, path: validConfigPath };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'await-source-truth-'));
  mkdirSync(join(root, 'queue'), { recursive: true });
  mkdirSync(join(root, 'outbox'), { recursive: true });
  validConfigPath = join(root, EMAIL_DROP_CONFIG_FILE);
  writeFileSync(validConfigPath, JSON.stringify({
    v: 1, inboxDir: join(root, 'inbox'), outboxDir: join(root, 'outbox'),
    from: ['owner@example.test'], enabled: false,
  }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeArgs(): ReturnType<typeof parseFleetEmailOutboxAwaitArgs> {
  return parseFleetEmailOutboxAwaitArgs({ name, timeoutMs: 300 })!;
}

describe('readFleetEmailOutboxAwait — config read and source-failure', () => {
  it.each(['drafted', 'sent'] as const)(
    'classifies %s terminal state when polling succeeds',
    async state => {
      const result = await readFleetEmailOutboxAwait(makeArgs(), undefined, {
        readConfig: async () => makeFakeConfig(),
        await: async opts => ({
          ...opts,
          state,
          timedOut: false,
          cancelled: false,
        }),
      });
      expect(result).toMatchObject({
        sourceState: 'ok',
        name,
        state,
        reason: null,
        timedOut: false,
        cancelled: false,
      });
    },
  );

  it('classifies stuck terminal state correctly', async () => {
    const result = await readFleetEmailOutboxAwait(makeArgs(), undefined, {
      readConfig: async () => makeFakeConfig(),
      await: async opts => ({
        ...opts,
        state: 'stuck',
        reason: 'symlink',
        timedOut: false,
        cancelled: false,
      }),
    });
    expect(result).toMatchObject({
      sourceState: 'ok',
      name,
      state: 'stuck',
      reason: 'symlink',
      timedOut: false,
      cancelled: false,
    });
  });

  it('reports ordinary timeout without changing state', async () => {
    const result = await readFleetEmailOutboxAwait(makeArgs(), undefined, {
      readConfig: async () => makeFakeConfig(),
      await: async () => ({
        name,
        state: 'queued',
        timedOut: true,
        cancelled: false,
      }),
    });
    expect(result).toMatchObject({
      sourceState: 'ok',
      name,
      state: 'queued',
      reason: null,
      timedOut: true,
      cancelled: false,
    });
  });

  it('does not report ok when polling returns source-failure — preserves statSync sourceState', async () => {
    const result = await readFleetEmailOutboxAwait(makeArgs(), undefined, {
      readConfig: async () => makeFakeConfig(),
      await: async () => ({
        name,
        state: 'queued',
        reason: 'source-failure',
        timedOut: false,
        cancelled: false,
      }),
    });
    expect(result).toMatchObject({
      sourceState: 'ok',
      name,
      state: null,
      reason: 'source-failure',
      timedOut: false,
      cancelled: false,
    });
  });

  it('preserves malformed reason as a normal stuck observation', async () => {
    const result = await readFleetEmailOutboxAwait(makeArgs(), undefined, {
      readConfig: async () => makeFakeConfig(),
      await: async () => ({
        name,
        state: 'queued',
        reason: 'malformed',
        timedOut: false,
        cancelled: false,
      }),
    });
    // malformed is a valid stuck reason, not source-failure; return the state.
    expect(result).toMatchObject({
      sourceState: 'ok',
      name,
      state: 'queued',
      reason: 'malformed',
      timedOut: false,
      cancelled: false,
    });
  });

  it('throws a config exception and returns invalid-config/source-failure', async () => {
    const privateFixture = 'PRIVATE-FIXTURE-error-uuid-7f3a9c21';
    const result = await readFleetEmailOutboxAwait(makeArgs(), undefined, {
      readConfig: async () => {
        throw new Error(privateFixture);
      },
    });
    expect(result).toMatchObject({
      sourceState: 'invalid-config',
      name,
      state: null,
      reason: 'source-failure',
      timedOut: false,
      cancelled: false,
    });
    // Exception message must NOT leak into the JSON output.
    const json = JSON.stringify(result);
    expect(json).not.toContain(privateFixture);
  });

  it('returns missing-config when config file is absent (stat path not reached)', async () => {
    const result = await readFleetEmailOutboxAwait(makeArgs(), undefined, {
      runsDir: join(root, 'nonexistent'),
    });
    expect(result).toMatchObject({
      sourceState: 'missing-config',
      name,
      state: null,
      reason: 'source-failure',
      timedOut: false,
      cancelled: false,
    });
  });

  it('returns invalid-config when config file exists but is invalid JSON', async () => {
    writeFileSync(validConfigPath, 'not-json');
    const result = await readFleetEmailOutboxAwait(makeArgs(), undefined, {
      runsDir: root,
    });
    expect(result).toMatchObject({
      sourceState: 'invalid-config',
      name,
      state: null,
      reason: 'source-failure',
      timedOut: false,
      cancelled: false,
    });
  });

  it('returns missing-outbox when outbox dir is absent', async () => {
    rmSync(join(root, 'outbox'), { recursive: true, force: true });
    const result = await readFleetEmailOutboxAwait(makeArgs(), undefined, {
      runsDir: root,
    });
    expect(result).toMatchObject({
      sourceState: 'missing-outbox',
      name,
      state: null,
      reason: 'source-failure',
      timedOut: false,
      cancelled: false,
    });
  });

  it('returns unreadable-outbox when outbox is a file', async () => {
    rmSync(join(root, 'outbox'), { recursive: true, force: true });
    writeFileSync(join(root, 'outbox'), 'not a dir');
    const result = await readFleetEmailOutboxAwait(makeArgs(), undefined, {
      runsDir: root,
    });
    expect(result).toMatchObject({
      sourceState: 'unreadable-outbox',
      name,
      state: null,
      reason: 'source-failure',
      timedOut: false,
      cancelled: false,
    });
  });

  it('preserves the statSync sourceState when polling encounters source-failure', async () => {
    // When outbox dir is missing but polling fails, sourceState should be
    // missing-outbox (from statSync), not forced to 'ok'.
    rmSync(join(root, 'outbox'), { recursive: true, force: true });
    const result = await readFleetEmailOutboxAwait(makeArgs(), undefined, {
      readConfig: async () => makeFakeConfig(),
      await: async () => ({
        name,
        state: 'queued',
        reason: 'source-failure',
        timedOut: false,
        cancelled: false,
      }),
    });
    expect(result).toMatchObject({
      sourceState: 'missing-outbox',
      name,
      state: null,
      reason: 'source-failure',
      timedOut: false,
      cancelled: false,
    });
  });

  it('pre-aborted input performs no config read', async () => {
    const readConfig = vi.fn(makeFakeConfig);
    const result = await readFleetEmailOutboxAwait(
      makeArgs(),
      (() => { const ac = new AbortController(); ac.abort(); return ac.signal; })(),
      { readConfig },
    );
    expect(readConfig).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sourceState: 'unobserved',
      name,
      state: null,
      reason: null,
      timedOut: false,
      cancelled: true,
    });
  });

  it('no paths, recipients, bodies or exception messages appear in output JSON', async () => {
    const leakable = 'should-not-appear/paths/to/files';
    const result = await readFleetEmailOutboxAwait(makeArgs(), undefined, {
      readConfig: async () => {
        throw new Error(leakable);
      },
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain(leakable);
    expect(json).not.toContain('should-not-appear');
  });
});
