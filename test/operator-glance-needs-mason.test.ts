import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readOperatorGlance } from '../src/core/fleet/operator-glance-read.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('NEEDS-MASON.md in operator glance', () => {
  const now = new Date('2026-11-02T15:00:00.000Z');

  it('prefixes NEEDS-MASON lines before INCIDENTS lines (case a)', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'glance-needs-'));
    dirs.push(runsDir);
    mkdirSync(join(runsDir, 'leader'));
    writeFileSync(join(runsDir, 'NEEDS-MASON.md'),
      '- [ ] safari-import[keychain]: Approve the one-time Keychain prompt.\n- [x] done thing\n');
    writeFileSync(join(runsDir, 'leader', 'INCIDENTS.md'),
      '- Ship needs a human\n');
    const glance = await readOperatorGlance({ runsDir, now: () => now });
    expect(glance.incidents).toEqual(['safari-import[keychain]: Approve the one-time Keychain prompt.', 'Ship needs a human']);
  });

  it('behaves identically without NEEDS-MASON.md (case b)', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'glance-no-needs-'));
    dirs.push(runsDir);
    mkdirSync(join(runsDir, 'leader'));
    writeFileSync(join(runsDir, 'leader', 'INCIDENTS.md'),
      '- Ship needs a human\n');
    const glance = await readOperatorGlance({ runsDir, now: () => now });
    expect(glance.incidents).toEqual(['Ship needs a human']);
  });

  it('returns empty incidents when neither file exists (case c)', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'glance-both-missing-'));
    dirs.push(runsDir);
    const glance = await readOperatorGlance({ runsDir, now: () => now });
    expect(glance.incidents).toEqual([]);
  });
});
