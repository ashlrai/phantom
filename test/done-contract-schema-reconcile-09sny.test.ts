import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { parseDoneContract } from '../src/core/done-contract-plan.js';

// Ajv is already available transitively; require avoids depending on its TS declarations.
const require = createRequire(import.meta.url);
const Ajv = require('ajv') as new () => {
  validateSchema: (schema: object) => boolean;
  compile: (schema: object) => (value: unknown) => boolean;
};
const schema = JSON.parse(readFileSync('schema/done-contract.v1.schema.json', 'utf8')) as object;
const ajv = new Ajv();
const validate = ajv.compile(schema);
const valid = {
  schema: 'done-contract.v1', job: 'fake-job', frozenAt: '2026-11-05T21:46:00Z',
  floor: { checks: ['typecheck', 'unit', 'lint', 'secrets'], commands: [{ id: 'inspect', cmd: ['node', 'file.js'], cwd: 'src', timeoutMs: 1000, required: false }] },
  acceptance: [{ id: 'criterion', text: 'A fake criterion', evidence: 'command:inspect', required: true }, { id: 'file', text: 'A file', evidence: 'file:src/fake.txt' }],
  verify: [{ id: 'verify', cmd: ['echo', 'hello; $(fake)'] }], notesFile: 'BRIDGE_NOTES.md',
};
const parserAccepts = (value: unknown): boolean => {
  try { parseDoneContract(JSON.stringify(value)); return true; } catch { return false; }
};

describe('done-contract draft-07 schema', () => {
  it('is a valid draft-07 schema and accepts representative contracts', () => {
    expect(ajv.validateSchema(schema)).toBe(true);
    for (const value of [valid, { schema: 'done-contract.v1', acceptance: [{ id: 'a', text: 'ok', evidence: 'manual' }], notesFile: null }]) {
      expect(validate(value)).toBe(true);
      expect(parserAccepts(value)).toBe(true);
    }
  });
  it('matches parser rejection of structural and path errors', () => {
    const command = (cmd: unknown, cwd?: string) => ({ schema: 'done-contract.v1', verify: [{ id: 'v', cmd, ...(cwd === undefined ? {} : { cwd }) }] });
    const invalid: unknown[] = [
      { ...valid, schema: 'done-contract.v2' }, { ...valid, extra: true },
      { schema: 'done-contract.v1' }, { schema: 'done-contract.v1', floor: {} },
      { schema: 'done-contract.v1', floor: { checks: ['build'] } },
      command('echo hello'), command([]), command(['line\nbreak']), command(['x'.repeat(513)]),
      command(['echo'], '/tmp'), command(['echo'], '../src'), command(['echo'], 'src/../tmp'), command(['echo'], 'C:/tmp'), command(['echo'], 'a\\b'),
      { schema: 'done-contract.v1', acceptance: [{ id: 'a', text: 'ok', evidence: 'file:../bad' }] },
      { schema: 'done-contract.v1', verify: [{ id: 'v', cmd: ['echo'], extra: true }] },
      { schema: 'done-contract.v1', verify: [{ id: 'v', cmd: ['echo'] }], notesFile: 'dir/notes.md' },
    ];
    for (const value of invalid) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
      expect(parserAccepts(value), JSON.stringify(value)).toBe(false);
    }
  });
  it('does not pretend to resolve IDs or prove completion', () => {
    const unresolved = { schema: 'done-contract.v1', acceptance: [{ id: 'a', text: 'ok', evidence: 'command:missing' }] };
    expect(validate(unresolved)).toBe(true);
    expect(parserAccepts(unresolved)).toBe(false);
    const duplicate = { schema: 'done-contract.v1', verify: [{ id: 'v', cmd: ['echo'] }, { id: 'v', cmd: ['echo'] }] };
    expect(validate(duplicate)).toBe(true);
    expect(parserAccepts(duplicate)).toBe(false);
  });
});
