import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKBENCH_SCHEMAS, validateWorkbench } from '../src/core/workbench/schema.js';

const DIR = join(__dirname, '..', 'schema', 'workbench.v1');
const FIX = join(__dirname, 'fixtures', 'workbench.v1');
const SECRET = 'sk-proj-ZXhhbXBsZVNlY3JldFRva2VuMTIzNDU2Nzg5MA';
const snapshot = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIX, 'snapshot.wb-export.json'), 'utf8')) as Record<string, unknown>;
const audit = {
  schema: 'workbench.audit-row.v1', ts: '2026-10-27T01:10:00-04:00', actor: 'cli', verb: 'land',
  args: { repo: 'ashlrai/phantom', pr: 1143 }, dry_run: true, result: 'planned', refusal_reason: null,
  command: ['gh', 'pr', 'merge', '1143', '--repo', 'ashlrai/phantom', '--auto', '--squash'],
};

describe('workbench.v1 schemas', () => {
  it('snapshot schema is byte-identical to the WB-2 exporter copy (sha cd341ec7)', () => {
    const sha = createHash('sha256').update(readFileSync(join(DIR, 'snapshot.schema.json'))).digest('hex');
    expect(sha).toBe('cd341ec7d217303950fc1a190b92a2bc06d5aa5ff75883c5d6933d31ca86dec4');
  });

  it('accepts a snapshot produced by wb_export.py', () => {
    expect(validateWorkbench(DIR, 'snapshot', snapshot())).toEqual([]);
  });

  it('rejects non-allowlisted snapshot keys and secret-shaped values', () => {
    expect(validateWorkbench(DIR, 'snapshot', { ...snapshot(), log_tail: 'x' })).toContain('$: unknown key');
    const s = snapshot();
    (s.inferred_empty as Array<Record<string, unknown>>).push({ job: SECRET, lane: 'claude', ts: null, inferred: true });
    const errs = validateWorkbench(DIR, 'snapshot', s);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join('\n')).not.toContain(SECRET);
    const lanes = snapshot().lanes as Array<Record<string, unknown>>;
    lanes[0].hold_pattern = `matched text ${SECRET}`;
    expect(validateWorkbench(DIR, 'snapshot', { ...snapshot(), lanes })).toContain('$.lanes[0].hold_pattern: enum');
  });

  it('accepts a dry-run land action and refuses unknown verbs and args', () => {
    const land = { schema: 'workbench.action.v1', verb: 'land', args: { repo: 'ashlrai/phantom', pr: 1143 }, dry_run: true };
    expect(validateWorkbench(DIR, 'action', land)).toEqual([]);
    expect(validateWorkbench(DIR, 'action', { ...land, verb: 'merge.admin' })).toContain('$.verb: enum');
    expect(validateWorkbench(DIR, 'action', { ...land, args: { pr: 1, admin: true } })).toContain('$.args: unknown key');
    expect(validateWorkbench(DIR, 'action', { ...land, confirm: 'not-a-nonce' })).toContain('$.confirm: pattern');
  });

  it('validates action results with the exact command argv', () => {
    const res = {
      schema: 'workbench.action-result.v1', verb: 'land', dry_run: true, result: 'planned', refusal_reason: null,
      command: audit.command, confirm: 'a'.repeat(32), confirm_expires_at: '2026-10-27T01:12:00-04:00',
    };
    expect(validateWorkbench(DIR, 'action-result', res)).toEqual([]);
    expect(validateWorkbench(DIR, 'action-result', { ...res, result: 'merged' })).toContain('$.result: enum');
  });

  it('audit rows never carry ask text or output', () => {
    expect(validateWorkbench(DIR, 'audit-row', audit)).toEqual([]);
    expect(validateWorkbench(DIR, 'audit-row', { ...audit, args: { text: 'ask' } })).toContain('$.args: unknown key');
    expect(validateWorkbench(DIR, 'audit-row', { ...audit, output: 'x' })).toContain('$: unknown key');
  });

  it('events embed audit rows by reference', () => {
    const ev = { schema: 'workbench.event.v1', kind: 'wb.action', ts: audit.ts, audit };
    expect(validateWorkbench(DIR, 'event', ev)).toEqual([]);
    expect(validateWorkbench(DIR, 'event', { ...ev, audit: { ...audit, actor: 'bot' } })).toContain('$.audit.actor: enum');
    expect(validateWorkbench(DIR, 'event', { ...ev, kind: 'wb.log' })).toContain('$.kind: enum');
  });

  it('every schema file parses and declares its title', () => {
    for (const name of WORKBENCH_SCHEMAS) {
      const s = JSON.parse(readFileSync(join(DIR, `${name}.schema.json`), 'utf8')) as { title: string };
      expect(s.title).toMatch(/^workbench\./);
    }
  });
});
