/**
 * Guard for scripts/docs-autosync.mjs — the daily-run step that keeps every
 * generated reference doc byte-identical to the source that produces it.
 *
 * The acceptance contract: the managed set covers every generated doc, and
 * each one is byte-fresh against its live source (real `phm --help` captures
 * for the CLI docs, the config schema for the config reference). The
 * subprocess captures live inside the imported modules, so this file carries
 * no spawn marker and stays in the unit lane; the full sweep gets an
 * explicit 120s hook budget for the real `phm` subprocesses.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// @ts-expect-error standalone Node orchestrator script has no declaration output
import { DOC_TARGETS, main, statusDocs, syncDocs } from '../scripts/docs-autosync.mjs';

const ROOT = join(__dirname, '..');

interface DocStatus { path: string; status: string; detail?: string }

let docs: DocStatus[];
beforeAll(async () => {
  docs = await statusDocs(ROOT);
}, 120_000);

describe('docs-autosync managed set', () => {
  it('covers every generated reference doc in stable order', () => {
    expect(DOC_TARGETS.map((target: { path: string }) => target.path)).toEqual([
      'docs/cli.md',
      'docs/CLI-REFERENCE.md',
      'docs/CONFIG-REFERENCE.md',
    ]);
    for (const target of DOC_TARGETS) {
      expect(
        existsSync(join(ROOT, target.path)),
        `${target.path} is managed but missing; regenerate it`,
      ).toBe(true);
    }
  });

  it('acceptance: generated docs match live `phm --help` output and the config schema', () => {
    for (const doc of docs) {
      expect(doc.status, `${doc.path}: ${doc.detail ?? 'unexpected status'}`).toBe('fresh');
    }
  });

  it('every status carries the doc path and a known status word', () => {
    expect(docs).toHaveLength(DOC_TARGETS.length);
    for (const doc of docs) {
      expect(doc.path).toMatch(/^docs\//);
      expect(['fresh', 'stale', 'written', 'error']).toContain(doc.status);
    }
  });
});

describe('docs-autosync aggregation logic', () => {
  const fake = (status: string, write?: () => void) => ({
    path: `docs/fake-${status}.md`,
    status: async () => ({ status }),
    write: async () => write?.(),
  });

  it('statusDocs reports each doc independently of sibling errors', async () => {
    const docs = await statusDocs(ROOT, [
      fake('fresh'),
      { path: 'docs/broken.md', status: async () => { throw new Error('boom'); }, write: async () => {} },
      fake('stale'),
    ]);
    expect(docs).toEqual([
      { path: 'docs/fake-fresh.md', status: 'fresh' },
      { path: 'docs/broken.md', status: 'error', detail: 'boom' },
      { path: 'docs/fake-stale.md', status: 'stale' },
    ]);
  });

  it('syncDocs rewrites only stale docs and reports written', async () => {
    const writes: string[] = [];
    const docs = await syncDocs(ROOT, [
      fake('fresh', () => writes.push('fresh')),
      fake('stale', () => writes.push('stale')),
      { path: 'docs/err.md', status: async () => ({ status: 'error', detail: 'nope' }), write: async () => writes.push('err') },
    ]);
    expect(writes).toEqual(['stale']);
    expect(docs.map((doc: DocStatus) => doc.status)).toEqual(['fresh', 'written', 'error']);
  });
});

describe('docs-autosync CLI surface', () => {
  it('--list prints the managed paths and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['--list'], ROOT)).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toBe(DOC_TARGETS.map((t: { path: string }) => t.path).join('\n'));
    } finally {
      log.mockRestore();
    }
  });

  it('rejects unknown and conflicting arguments with usage exit 2', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['--bogus'], ROOT)).toBe(2);
      expect(await main(['--check', '--list'], ROOT)).toBe(2);
      expect(error.mock.calls.flat().join('\n')).toContain('usage:');
    } finally {
      error.mockRestore();
    }
  });

  it('--help prints usage and exits 0 without touching docs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await main(['--help'], ROOT)).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('--check');
    } finally {
      log.mockRestore();
    }
  });
});
