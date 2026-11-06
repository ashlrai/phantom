import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { askLogView, validateAsk, validateAskStatus, type AskV1 } from '../src/core/ask-flow/schema.js';

const FIX = join(__dirname, 'fixtures', 'ask.v1');
const load = (f: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIX, f), 'utf8')) as Record<string, unknown>;
const ask = (): Record<string, unknown> => load('ask.json');
const st = (): Record<string, unknown> => load('status-merged.json');
const SECRET = 'sk-' + 'EXAMPLE'.repeat(4);

describe('ask.v1', () => {
  it('accepts the spec example', () => expect(validateAsk(ask())).toEqual([]));

  it('rejects unknown keys, bad repo, .github and traversal paths', () => {
    expect(validateAsk({ ...ask(), argv: ['x'] })).toContain('$: unknown key');
    expect(validateAsk({ ...ask(), repo: 'evil/phantom' })).toContain('$.repo: pattern');
    expect(validateAsk({ ...ask(), paths: ['.github/workflows/ci.yml'] })).toContain('$.paths[0]: pattern');
    expect(validateAsk({ ...ask(), paths: ['src/../../etc'] })).toContain('$.paths[0]: pattern');
    expect(validateAsk({ ...ask(), n: 4 })).toContain('$.n: maximum');
  });

  it('rejects secret-shaped strings without echoing them', () => {
    const errs = validateAsk({ ...ask(), text: `use ${SECRET}` });
    expect(errs).toEqual(['$.text: secret_shape']);
    expect(errs.join()).not.toContain(SECRET);
  });

  it('enforces refusal, pr and n cross-field rules', () => {
    expect(validateAsk({ ...ask(), state: 'refused', pr: null, pr_url: null, job_ids: [], refusal_reason: 'multi_repo' })).toEqual([]);
    expect(validateAsk({ ...ask(), state: 'refused' })).toContain('$.refusal_reason: state');
    expect(validateAsk({ ...ask(), refusal_reason: 'because' })).toContain('$.refusal_reason: enum');
    expect(validateAsk({ ...ask(), pr: 99 })).toContain('$.pr_url: pr');
    expect(validateAsk({ ...ask(), n: 1 })).toContain('$.job_ids: n');
  });

  it('log view drops ask text and acceptance strings', () => {
    const v = askLogView(ask() as unknown as AskV1);
    expect(JSON.stringify(v)).not.toContain('--json flag');
    expect(v).toMatchObject({ text_len: 36, acceptance_count: 1, id: 'RQ-ASK-20261027-7K2Q' });
  });
});

describe('ask.status.v1', () => {
  it('accepts a merged event with tokens_total', () => expect(validateAskStatus(st())).toEqual([]));

  it('requires merged_at for merged and reverted_at only for reverted', () => {
    expect(validateAskStatus({ ...st(), merged_at: null })).toContain('$.merged_at: state');
    expect(validateAskStatus({ ...st(), state: 'reverted' })).toContain('$.reverted_at: state');
    expect(validateAskStatus({ ...st(), state: 'reverted', reverted_at: '2026-10-28T01:00:00-04:00' })).toEqual([]);
  });

  it('publish_only and refused states', () => {
    const base = { ...st(), pr: null, pr_url: null, merged_at: null };
    expect(validateAskStatus({ ...base, state: 'publish_only' })).toEqual([]);
    expect(validateAskStatus({ ...base, state: 'refused', reason: 'hold_list' })).toEqual([]);
    expect(validateAskStatus({ ...base, state: 'refused', reason: 'other' })).toContain('$.reason: state');
    expect(validateAskStatus({ ...base, state: 'pr_open' })).toContain('$.pr: state');
  });

  it('rejects unknown states, pools and negative tokens', () => {
    expect(validateAskStatus({ ...st(), state: 'done' })).toContain('$.state: enum');
    expect(validateAskStatus({ ...st(), pool: 'gpt' })).toContain('$.pool: enum');
    expect(validateAskStatus({ ...st(), tokens_total: -1 })).toContain('$.tokens_total: minimum');
    expect(validateAskStatus({ ...st(), log: 'x' })).toContain('$: unknown key');
  });
});
