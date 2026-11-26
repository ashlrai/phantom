import { describe, expect, it } from 'vitest';
import { conflictingPrIds } from '../src/core/fleet/leader-board.js';

describe('leader board rebase members recovered from #7167', () => {
  it('counts every member PR of batch rebase rows and unknown-head singles', () => {
    const ids = conflictingPrIds([
      'READY\tRQ-REBASE-BATCH-PHANTOM-4021-4023-a1b2c3\tdevin\twork',
      'READY\tRQ-REBASE-BATCH-phantom-secrets-168-418-abcdef\tcodex\twork',
      'READY\tRQ-REBASE-PHANTOM-4021-u3f2a1b\tdevin\twork',
      'PARKED-DEP.devin\tRQ-REBASE-BATCH-PHANTOM-4021-4023-a1b2c3\tdevin\twork',
      'READY\tRQ-REBASE-BATCH-PHANTOM-4021-4023-a1b2cX\tdevin\twork',
      'READY\tRQ-REBASE-BATCH-PHANTOM-4021\tdevin\twork',
      'READY\tRQ-TEST-1\tdevin\twork',
    ].join('\n'));
    expect([...ids].sort()).toEqual([
      'PHANTOM-4021',
      'PHANTOM-4023',
      'PHANTOM-SECRETS-168',
      'PHANTOM-SECRETS-418',
    ]);
  });

  it('never interprets a batch as a single, including malformed batch tokens', () => {
    expect([...conflictingPrIds('RQ-REBASE-BATCH-PHANTOM-7-8-abcdef')]).toEqual(['PHANTOM-7', 'PHANTOM-8']);
    expect([...conflictingPrIds('RQ-REBASE-BATCH-PHANTOM-7-8-abcdef0')]).toEqual([]);
  });

  it('counts rebase job IDs independently of references in other queue cells', () => {
    expect([...conflictingPrIds([
      'RQ-FIX\tphantom\t\twork\tprompts/RQ-REBASE-PHANTOM-90-uabcdef.md',
      'READY\tRQ-FIX-2\tcodex\twork\tphantom\tReview RQ-REBASE-PHANTOM-91-uabcdef',
      'RQ-REBASE-PHANTOM-7-uabcdef\tphantom\t\twork\tprompts/RQ-REBASE-BATCH-PHANTOM-90-91-abcdef.md',
      'PARKED-DEP.codex\tRQ-REBASE-PHANTOM-8-abcdef0\tcodex\twork\tphantom\tNeeds RQ-REBASE-PHANTOM-92-uabcdef',
      'RQ-REBASE-PHANTOM-93-uabcdef.md\tphantom\tcodex\twork\tprompt.md',
    ].join('\n'))]).toEqual(['PHANTOM-7', 'PHANTOM-8']);
  });

  it.each([
    'RQ-REBASE-BATCH-PHANTOM-7-8-abcdef-suffix',
    'RQ-REBASE-BATCH-PHANTOM-7-8-abcdefX',
    'RQ-REBASE-PHANTOM-7-uabcdef0',
    'RQ-REBASE-PHANTOM-7-uabcdef-suffix',
    'RQ-REBASE-PHANTOM-7-abcdef0X',
    'RQ-REBASE-PHANTOM-7-abcdef0-suffix',
  ])('rejects incomplete or suffixed identifiers: %s', id => {
    expect([...conflictingPrIds(id)]).toEqual([]);
  });

  it('retains SHA singles, parked conflicts, cross-repo identity and comment filtering', () => {
    expect([...conflictingPrIds([
      '# RQ-REBASE-PHANTOM-99-uabcdef',
      '  # RQ-REBASE-BATCH-PHANTOM-98-97-abcdef',
      'READY\tRQ-REBASE-PHANTOM-7-abcdef0',
      'RQ-REBASE-phantom-7-uabcdef\trepo\tPARKED-DEP.work\twork\tprompt.md',
      'PARKED-HOLD\tRQ-REBASE-SECRETS-7-uabcdef',
    ].join('\n'))].sort()).toEqual(['PHANTOM-7', 'SECRETS-7']);
  });
});
