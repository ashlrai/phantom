/**
 * Regression pin for the RQ-PHX-REDTYPEFIXC158 fix (supersedes PR #5087).
 *
 * PR #5087 added src/core/comms/teammate-context-evidence.ts plus a runtime
 * import of it from imessage-teammate-worker.ts, which is already a Tier-1
 * authority import-closure member. The PR did not regenerate the closure
 * snapshot, so the hermetic authority drift check failed CI with "the runtime
 * import closure has not grown" listing the new file. This pins the exact
 * contract that was missed: a source file that exists on disk and is reached
 * from the worker must be blessed in the snapshot.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = join(ROOT, 'test', 'fixtures', 'authority', 'tier1-closure.json');
const EVIDENCE = 'src/core/comms/teammate-context-evidence.ts';

describe('redfix-c158: Tier-1 closure snapshot covers the teammate evidence module', () => {
  it('the evidence source file exists on disk', () => {
    expect(existsSync(join(ROOT, EVIDENCE)), `${EVIDENCE} must exist`).toBe(true);
  });

  it('the evidence module is blessed in the Tier-1 closure snapshot', () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { closure: string[] };
    expect(
      snapshot.closure,
      'imessage-teammate-worker.ts is a Tier-1 closure member and imports this module at runtime; regenerate with ASHLR_UPDATE_TIER1_CLOSURE=1 npx vitest run test/authority-tier1-closure-310b.test.ts',
    ).toContain(EVIDENCE);
  });
});
