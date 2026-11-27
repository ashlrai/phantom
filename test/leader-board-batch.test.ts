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

  it('parses repo short names with dots, underscores and digit segments', () => {
    const ids = conflictingPrIds([
      'READY\tRQ-REBASE-BATCH-my.repo-12-34-a1b2c3\tdevin\twork',
      'READY\tRQ-REBASE-my_repo-7-abcdef0\tdevin\twork',
      'READY\tRQ-REBASE-BATCH-svc-2-123-456-a1b2c3\tdevin\twork',
      'READY\tRQ-REBASE-svc-2-123-abcdef0\tdevin\twork',
      'READY\tRQ-REBASE-BATCH-2024-app-5-6-abcdef\tdevin\twork',
      'READY\tRQ-REBASE-BATCH-legacy-9-a1b2c3\tdevin\twork',
    ].join('\n'));
    expect([...ids].sort()).toEqual([
      '2024-APP-5',
      '2024-APP-6',
      'LEGACY-9',
      'MY.REPO-12',
      'MY.REPO-34',
      'MY_REPO-7',
      'SVC-2-123',
      'SVC-2-456',
    ]);
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

  it('counts job IDs without picking up rebase references in prompts or requirements', () => {
    const ids = conflictingPrIds([
      'READY\tRQ-OTHER\tcodex\twork\tphantom\tFollow RQ-REBASE-PHANTOM-99-uabcdef',
      'READY\tRQ-REBASE-PHANTOM-7-uabcdef\tcodex\twork\tphantom\tSee RQ-REBASE-BATCH-PHANTOM-98-97-abcdef',
      'RQ-OTHER\tphantom\tcodex\twork\tprompt.md\t{"dependency":"RQ-REBASE-PHANTOM-96-uabcdef"}',
      'state=PARKED-DEP.codex\tlane=codex\tjob_id=RQ-REBASE-SECRETS-8-uabcdef',
      'title\tpool\tjob_id\tstatus',
      'RQ-REBASE-PHANTOM-95-uabcdef\tcodex\tRQ-OTHER\tREADY',
      'Rebase batch\tcodex\tRQ-REBASE-BATCH-PHANTOM-10-11-abcdef\tPARKED-DEP.codex',
    ].join('\n'));
    expect([...ids]).toEqual(['PHANTOM-7', 'SECRETS-8', 'PHANTOM-10', 'PHANTOM-11']);
  });
});
