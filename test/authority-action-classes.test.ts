/**
 * RQ-SWE5-ACTION-CLASSES (digest item 7) — the unified action-class autonomy
 * registry: eight named classes, each with an explicit gate policy, blast
 * radius and reversibility; one resolver consumed by the Leader (directly) and
 * by dispatchd/publish.sh (through the checked-in JSON projection). Fail closed
 * for unlisted names.
 *
 * Hermetic: no HOME reads beyond the checked-in projection file; the Leader
 * classification cases build the same fake policy context as
 * leader-apply-310b.test.ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ACTION_CLASSES,
  ACTION_CLASS_GATES,
  ACTION_CLASS_REGISTRY,
  ACTION_CLASSES_SCHEMA,
  BLAST_RADIUS_ORDER,
  BLAST_RADIUS_RANK,
  DEFAULT_JOB_ACTION_CLASS,
  JOB_ACTION_CLASS_PREFIXES,
  LEADER_KIND_ACTION_CLASS,
  PUBLISHABLE_GATES,
  REVERSIBILITIES,
  actionClassDisposition,
  actionClassForJobId,
  actionClassForLeaderKind,
  actionClassesProjection,
  autonomyMayRun,
  isActionClass,
  mayDispatchPublish,
  resolveActionClass,
} from '../src/core/authority/action-classes.js';
import { classifyLeaderAction, type LeaderPolicyContext } from '../src/core/vision/leader-apply.js';
import type { AnyLeaderActionDraft } from '../src/core/vision/leader-memo.js';
import { makePolicy } from './helpers/leader-310b-fakes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('registry vocabulary', () => {
  it('lists exactly the eight required classes', () => {
    expect([...ACTION_CLASSES].sort()).toEqual([
      'close', 'external-comms', 'merge', 'publish', 'read', 'release',
      'secrets-touch', 'write-worktree',
    ]);
  });

  it('gives every class an explicit gate policy, blast radius and reversibility', () => {
    for (const id of ACTION_CLASSES) {
      const entry = ACTION_CLASS_REGISTRY[id];
      expect(entry.listed).toBe(true);
      expect(entry.id).toBe(id);
      expect(ACTION_CLASS_GATES).toContain(entry.gate);
      expect(BLAST_RADIUS_ORDER).toContain(entry.blastRadius);
      expect(REVERSIBILITIES).toContain(entry.reversibility);
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  it('orders blast radii with unknown widest and pins the rank table', () => {
    expect(BLAST_RADIUS_ORDER[0]).toBe('none');
    expect(BLAST_RADIUS_ORDER[BLAST_RADIUS_ORDER.length - 1]).toBe('unknown');
    expect(BLAST_RADIUS_RANK['unknown']).toBeGreaterThan(BLAST_RADIUS_RANK['credentials']);
  });
});

describe('resolveActionClass — fail closed', () => {
  it('returns the listed entry for a listed name', () => {
    const entry = resolveActionClass('publish');
    expect(entry).toMatchObject({ listed: true, id: 'publish', gate: 'publish-pipeline' });
  });

  it.each(['', 'publishh', 'Read', ' read', 'unlisted', 'secrets-touc'])(
    'returns the forbidden unlisted descriptor for %j',
    (name) => {
      const entry = resolveActionClass(name);
      expect(entry).toMatchObject({
        listed: false, name, gate: 'forbidden',
        blastRadius: 'unknown', reversibility: 'irreversible',
      });
      expect(actionClassDisposition(name)).toBe('forbidden');
      expect(autonomyMayRun(name)).toBe(false);
      expect(mayDispatchPublish(name)).toBe(false);
      expect(isActionClass(name)).toBe(false);
    },
  );

  it('never throws on arbitrary input', () => {
    for (const name of ['\0', 'a'.repeat(4096), 'publish\nclose', '../../etc/passwd']) {
      expect(() => resolveActionClass(name)).not.toThrow();
      expect(resolveActionClass(name).listed).toBe(false);
    }
  });
});

describe('actionClassDisposition', () => {
  it('marks secrets-touch forbidden and every gated class allowed', () => {
    expect(actionClassDisposition('secrets-touch')).toBe('forbidden');
    expect(ACTION_CLASS_REGISTRY['secrets-touch'].gate).toBe('forbidden');
    for (const id of ACTION_CLASSES) {
      if (id !== 'secrets-touch') expect(actionClassDisposition(id)).toBe('allowed');
    }
  });
});

describe('job classification', () => {
  it('maps drain/desk jobs to merge, close jobs to close, everything else to publish', () => {
    expect(actionClassForJobId('RQ-DRAIN-phantom-1-x')).toBe('merge');
    expect(actionClassForJobId('RQ-DESK-A')).toBe('merge');
    expect(actionClassForJobId('RQ-CLOSE-123')).toBe('close');
    expect(actionClassForJobId('CLOSE-9')).toBe('close');
    expect(actionClassForJobId('RQ-ANYTHING')).toBe('publish');
    expect(actionClassForJobId('RQ-BATCH-x')).toBe('publish');
    expect(actionClassForJobId('')).toBe('publish');
    expect(DEFAULT_JOB_ACTION_CLASS).toBe('publish');
    for (const [, cls] of JOB_ACTION_CLASS_PREFIXES) expect(isActionClass(cls)).toBe(true);
  });

  it('keeps the generic publish path to publishable gates only', () => {
    expect(PUBLISHABLE_GATES).toEqual(['publish-pipeline', 'merge-queue']);
    for (const id of ACTION_CLASSES) {
      expect(mayDispatchPublish(id)).toBe(['publish', 'merge', 'close'].includes(id));
    }
  });
});

describe('leader kinds', () => {
  it('maps only external-effect kinds, and only to listed classes', () => {
    expect(LEADER_KIND_ACTION_CLASS).toEqual({
      'work.dispatch': 'write-worktree',
      'cloud.launch': 'write-worktree',
      'devin.launch': 'write-worktree',
      'pr.close': 'close',
    });
    for (const cls of Object.values(LEADER_KIND_ACTION_CLASS)) expect(isActionClass(cls!)).toBe(true);
    expect(actionClassForLeaderKind('escalate')).toBeNull();
    expect(actionClassForLeaderKind('goal.create')).toBeNull();
    expect(actionClassForLeaderKind('pr.close')).toBe('close');
  });
});

describe('JSON projection', () => {
  it('is deterministic and schema-versioned', () => {
    const a = actionClassesProjection();
    expect(a.schema).toBe(ACTION_CLASSES_SCHEMA);
    expect(JSON.stringify(a)).toBe(JSON.stringify(actionClassesProjection()));
  });

  it('equals the checked-in Mac mirror byte-for-byte when serialized', () => {
    const disk = JSON.parse(readFileSync(join(ROOT, 'contrib/mac/action-classes.json'), 'utf8'));
    expect(JSON.parse(JSON.stringify(actionClassesProjection()))).toEqual(disk);
  });
});

describe('classifyLeaderAction consults the registry first', () => {
  const NOW = Date.parse('2026-09-24T12:00:00.000Z');

  function ctx(overrides: Partial<LeaderPolicyContext> = {}): LeaderPolicyContext {
    return {
      nowMs: NOW,
      policy: makePolicy(),
      budgetMode: 'balanced',
      directives: null,
      codex: { ready: null, resetsAt: null },
      openGoalCount: 2,
      goalCreatesLast24h: 0,
      hypothesisIds: [],
      ...overrides,
    };
  }

  function draft<K extends AnyLeaderActionDraft['kind']>(
    kind: K,
    params: Extract<AnyLeaderActionDraft, { kind: K }>['params'],
  ): AnyLeaderActionDraft {
    return { kind, params, summary: `${kind} test`, why: 'registry test' } as AnyLeaderActionDraft;
  }

  it('a mapped kind whose class is allowed still classifies on the A/B/C axis', () => {
    expect(classifyLeaderAction(draft('pr.close', { repo: 'ashlrai/phantom', number: 1, reason: 'stale' }), ctx()).class).toBe('A');
    const task = { repo: 'ashlrai/binshield', source: 'leader' as const, title: 't', detail: '', difficulty: 'low' as const, value: 3, requestedBy: 'leader' as const };
    expect(classifyLeaderAction(draft('work.dispatch', { task }), ctx()).class).toBe('A');
  });

  it('registry refusal precedes and cannot be bypassed by grant checks', () => {
    // secrets-touch is forbidden; no leader kind maps to it, and the kind map is
    // a closed record — a kind absent from it gets no external-effect class at all.
    for (const kind of ['escalate', 'goal.create', 'standard.add', 'directive.self'] as const) {
      expect(actionClassForLeaderKind(kind)).toBeNull();
    }
  });
});
