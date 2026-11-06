import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

/**
 * Worker leftovers at the repo root. Fixed name list; the repo is never
 * scanned, so re-landing any absent name fails this suite.
 */
const STRAYS = [
  { name: 'debug-31b3.mjs', expect: 'absent' },
  { name: 'notes.md', expect: 'absent' },
  { name: 'task_plan.md', expect: 'absent' },
  { name: 'RQ-REALPRTITLES2Q7', expect: 'absent' },
  // Kept: scripts/ci-queue-report.mjs --help sends readers to RQ-QUEUE.md
  // for the capture envelope format.
  { name: 'RQ-QUEUE.md', expect: 'kept' },
  // Kept: .gitignore re-includes it (!/usage-readings.log) as sanitized
  // operator usage readings for bridge handoff, per gitignore-routing-eval.
  { name: 'usage-readings.log', expect: 'kept' },
] as const;

describe('repo root strays', () => {
  it.each(STRAYS.filter(stray => stray.expect === 'absent'))('%s must not exist at the repo root', ({ name }) => {
    expect(existsSync(join(ROOT, name)), `${name} re-landed at the repo root`).toBe(false);
  });

  it.each(STRAYS.filter(stray => stray.expect === 'kept'))('%s is intentionally kept and must remain', ({ name }) => {
    expect(existsSync(join(ROOT, name)), `${name} is still referenced; see this suite for why`).toBe(true);
  });
});
