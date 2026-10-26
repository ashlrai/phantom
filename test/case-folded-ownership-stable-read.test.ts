/**
 * Case-folded ownership claims (src/core/util/case-folded-ownership.ts) are
 * read with a stable read bound to the store and anchor directories. Saves of
 * OTHER records rename into the same directory, so the read can report
 * `changed-during-read` while this claim is held under its own write lock.
 * That transient reason is retried a bounded number of times; any other
 * reason, or instability that persists, still fails closed.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StableFileReadFailureReason } from '../src/core/util/stable-file-read.js';

const inject = vi.hoisted(() => ({ failures: 0, reason: 'changed-during-read' as string, claimReads: 0 }));

vi.mock('../src/core/util/stable-file-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/stable-file-read.js')>();
  return {
    ...actual,
    readStableRegularFile: (...args: Parameters<typeof actual.readStableRegularFile>) => {
      if (String(args[0]).includes('.id-claim-')) {
        inject.claimReads += 1;
        if (inject.failures > 0) {
          inject.failures -= 1;
          return { ok: false, reason: inject.reason as StableFileReadFailureReason };
        }
      }
      return actual.readStableRegularFile(...args);
    },
  };
});

import { acquireCaseFoldedOwnership } from '../src/core/util/case-folded-ownership.js';

let anchor: string;
let storeDir: string;

beforeEach(() => {
  anchor = realpathSync(mkdtempSync(join(tmpdir(), 'case-own-')));
  storeDir = join(anchor, 'runs');
  mkdirSync(storeDir, { mode: 0o700 });
  inject.failures = 0;
  inject.reason = 'changed-during-read';
  inject.claimReads = 0;
});

afterEach(() => {
  rmSync(anchor, { recursive: true, force: true });
});

function acquire(): ReturnType<typeof acquireCaseFoldedOwnership> {
  return acquireCaseFoldedOwnership({
    anchorPath: anchor,
    storeDir,
    recordFile: join(storeDir, 'Run-A.json'),
    id: 'Run-A',
    label: 'Run',
  });
}

describe('case-folded ownership claim reads', () => {
  it('re-reads a claim that changed during the read and keeps the same ownership', () => {
    const first = acquire();
    expect(first).not.toBeNull();
    inject.claimReads = 0;
    inject.failures = 2;
    const again = acquire();
    expect(again).toMatchObject({ id: 'Run-A', token: first!.token });
    expect(inject.claimReads).toBeGreaterThanOrEqual(3);
  });

  it('still fails closed when the claim keeps changing', () => {
    acquire();
    inject.claimReads = 0;
    inject.failures = 1_000;
    expect(() => acquire()).toThrow(/Invalid legacy case-folded ownership claim/);
    expect(inject.claimReads).toBe(5);
  });

  it('never retries any other unsafe reason', () => {
    acquire();
    inject.claimReads = 0;
    inject.reason = 'unsafe-file';
    inject.failures = 1;
    expect(() => acquire()).toThrow(/Invalid legacy case-folded ownership claim/);
    expect(inject.claimReads).toBe(1);
  });
});
