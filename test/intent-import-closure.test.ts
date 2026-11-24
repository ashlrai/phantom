/**
 * Regression pin for PR #5315 (RQ-PHX-INTENTCLOSUREFIX406C): the intent edit
 * modules added for native `intent_add` / `intent_update` must satisfy the
 * Tier-1 runtime import closure (test/authority-tier1-closure-310b.test.ts).
 *
 * PR #5315 wired the tools with a literal `import('./intent/native-edit.js')`,
 * which pulled native-edit.ts plus its ledger dependencies (edit.ts,
 * schema.ts, store.ts) into the authority closure unblessed and failed the
 * snapshot check. The landed fix loads the module through callNativeTool's
 * gated dispatch with a non-literal specifier (`import('...' as string)`):
 * the write path stays outside the authority closure while every module it
 * touches remains blessed.
 *
 * The checker functions come from scripts/tier1-why.ts, the verbatim copy of
 * the closure test's runtime walk — this file reuses them, it does not
 * reimplement them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { computeClosure, reachableClosure } from '../scripts/tier1-why.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = join(ROOT, 'test', 'fixtures', 'authority', 'tier1-closure.json');

const NATIVE_EDIT = 'src/core/intent/native-edit.ts';
const BLESSED_MODULES = ['src/core/intent/edit.ts', 'src/core/intent/schema.ts', 'src/core/intent/store.ts'] as const;
const INTENT_MODULES = [...BLESSED_MODULES, NATIVE_EDIT] as const;

describe('intent modules satisfy the Tier-1 runtime import closure (PR #5315)', () => {
  const { closure } = computeClosure();
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { closure: string[] };
  const blessed = new Set(snapshot.closure);

  it('the four intent modules exist on disk', () => {
    for (const file of INTENT_MODULES) {
      expect(existsSync(join(ROOT, file)), `${file} must exist`).toBe(true);
    }
  });

  it('the ledger modules stay blessed members of the authority closure', () => {
    for (const file of BLESSED_MODULES) {
      expect(blessed.has(file), `${file} must be blessed in the closure snapshot`).toBe(true);
      expect(closure, `${file} must stay reachable from the Tier-1 roots`).toContain(file);
    }
  });

  it('native-edit stays behind the gated dispatch boundary', () => {
    // callNativeTool loads it via `import('./intent/native-edit.js' as string)` —
    // a non-literal specifier the runtime walk cannot see — so the write path
    // never joins the authority closure. Absence from the computed closure is
    // unreachability: the walk is the same one the snapshot check runs.
    expect(closure).not.toContain(NATIVE_EDIT);
  });

  // This walk took 3.29s on origin/master; leave headroom for larger closures.
  it('every module the intent files reach is already blessed', () => {
    // The only unblessed file the walk may touch is native-edit.ts itself:
    // nothing inside the closure imports it, and it imports nothing outside it.
    const reached = reachableClosure(INTENT_MODULES);
    expect(reached.filter((file) => !blessed.has(file))).toEqual([NATIVE_EDIT]);
  }, 10_000);
});
