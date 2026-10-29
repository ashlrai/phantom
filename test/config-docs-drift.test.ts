/**
 * Drift guard for docs/CONFIG-REFERENCE.md.
 *
 * docs/CONFIG-REFERENCE.md is generated from schema/config.schema.json by
 * scripts/generate-config-docs.mjs and committed. This regenerates the
 * document in memory and compares it byte-for-byte with the committed file,
 * so a schema change that forgets the regeneration step fails here instead of
 * letting the published config reference drift from the validator a user runs.
 *
 * Fix a failure with: node scripts/generate-config-docs.mjs
 *
 * Generation is a pure schema read — no subprocesses, so this file stays in
 * the unit lane.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// @ts-expect-error standalone Node generator script has no declaration output
import {
  buildConfigDocs,
  checkConfigDocs,
  firstDiff,
  makeResolver,
  renderConfigDoc,
  schemaRows,
} from '../scripts/generate-config-docs.mjs';

const ROOT = join(__dirname, '..');
const DOC_PATH = join(ROOT, 'docs/CONFIG-REFERENCE.md');
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'schema/config.schema.json'), 'utf8')) as {
  required?: string[];
  properties?: Record<string, { description?: string }>;
};

const generated = buildConfigDocs({ repoRoot: ROOT });

describe('docs/CONFIG-REFERENCE.md drift guard', () => {
  it('committed doc matches the schema byte-for-byte', () => {
    expect(existsSync(DOC_PATH), 'docs/CONFIG-REFERENCE.md missing; run `node scripts/generate-config-docs.mjs`').toBe(true);
    const actual = readFileSync(DOC_PATH, 'utf8');
    const diff = firstDiff(actual, generated);
    expect(
      diff,
      'docs/CONFIG-REFERENCE.md is stale; run `node scripts/generate-config-docs.mjs` to regenerate',
    ).toBeNull();
    expect(actual).toBe(generated);
  });

  it('the script check path agrees', () => {
    expect(checkConfigDocs(ROOT).ok).toBe(true);
  });

  it('is deterministic and Markdown-clean', () => {
    expect(buildConfigDocs({ repoRoot: ROOT })).toBe(generated);
    expect(generated.endsWith('\n')).toBe(true);
    expect(generated.endsWith('\n\n')).toBe(false);
    expect(generated).not.toMatch(/[ \t]+$/m);
    expect(generated).not.toContain('\r');
    // Every row is a well-formed four-column table row (escaped `\|` inside
    // enum cells is stripped before counting separators).
    for (const line of generated.split('\n').filter((l) => l.startsWith('| `'))) {
      expect(line.endsWith('|'), line).toBe(true);
      expect(line.replace(/\\\|/g, '').split('|').length - 2, line).toBe(4);
    }
  });

  it('documents every top-level schema key with its required flag', () => {
    for (const key of Object.keys(SCHEMA.properties ?? {})) {
      expect(generated).toContain(`| \`${key}\` |`);
    }
    for (const key of SCHEMA.required ?? []) {
      const row = generated.split('\n').find((line) => line.startsWith(`| \`${key}\` |`));
      expect(row, `required key ${key} missing a top-level row`).toBeDefined();
      expect(row).toContain('| yes |');
    }
    // Optional keys render 'no'; array element / map / union rows render '-'.
    expect(generated).toContain('| no |');
    expect(generated).toContain('[]`');
  });

  it('renders enums, consts, union variants, $refs and constraints', () => {
    const fixture = {
      definitions: {
        Rule: {
          type: 'object', additionalProperties: false, required: ['match'],
          properties: { match: { type: 'string' }, kind: { enum: ['a', 'b'] } },
        },
      },
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['fast', 'safe'], description: 'Pick one.' },
        level: { type: 'integer', minimum: 1, maximum: 9 },
        locked: { const: true, description: 'Pinned.' },
        rules: { type: 'array', items: { $ref: '#/definitions/Rule' } },
        plan: { oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'null' }] },
        labels: { type: 'object', additionalProperties: { type: 'number' } },
      },
    };
    const doc = renderConfigDoc(fixture);
    expect(doc).toContain("`string` enum: `'fast'` \\| `'safe'`");
    expect(doc).toContain('`integer` (>= 1; <= 9)');
    expect(doc).toContain('const `true`');
    expect(doc).toContain('array of `object` (2 keys; closed)');
    expect(doc).toContain('| `rules[].kind` |');
    expect(doc).toContain('| `plan` | one of 2: |');
    expect(doc).toContain('| `plan<1>.a` | `string` |');
    expect(doc).toContain('| `labels.*` | `number` |');
  });

  it('rejects unresolvable $refs instead of emitting a partial doc', () => {
    expect(() => renderConfigDoc({
      properties: { broken: { $ref: '#/definitions/Missing' } },
    })).toThrow('unsupported $ref');
    const resolveRef = makeResolver({ definitions: { A: { type: 'object' } } });
    expect(resolveRef('#/definitions/A')).toEqual({ type: 'object' });
  });

  it('expands a shared definition for every sibling that references it', () => {
    const fixture = {
      definitions: { D: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } } },
      properties: {
        one: { type: 'array', items: { $ref: '#/definitions/D' } },
        two: { type: 'array', items: { $ref: '#/definitions/D' } },
      },
    };
    const doc = renderConfigDoc(fixture);
    expect(doc).toContain('| `one[].x` | `string` | yes |');
    expect(doc).toContain('| `two[].x` | `string` | yes |');
    const rows = [...schemaRows(fixture.properties.one, { path: 'one', emit: false, resolveRef: makeResolver(fixture) })];
    expect(rows.map((row) => row.path)).toEqual(['one[]', 'one[].x']);
  });
});
