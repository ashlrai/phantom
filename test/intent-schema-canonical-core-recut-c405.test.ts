import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Recut of PR #5934 (source #5263): the native evidence wire contract lives in
// the intent schema module so pure-schema consumers never pull the MCP handler
// module or its lazy store/release dependencies. mcp-evidence re-exports the
// same objects, so existing import sites keep working.
import { EVIDENCE_SCHEMAS, validEvidenceArgs, type EvidenceToolName } from '../src/core/intent/schema.js';
import * as mcpEvidence from '../src/core/intent/mcp-evidence.js';

const here = dirname(fileURLToPath(import.meta.url));
const link = { repo: 'example/project', number: 7, title: 'RQ-ALPHA-1 merged' };
const ship = { release: 'v1.2.3', rq: ['RQ-ALPHA-1'] };

describe('intent evidence contract canonical home (recut c405)', () => {
  it('schema.js exports the wire contract and validator directly', () => {
    for (const name of ['intent_link', 'intent_ship'] as const satisfies EvidenceToolName[]) {
      expect(EVIDENCE_SCHEMAS[name].type).toBe('object');
      expect(EVIDENCE_SCHEMAS[name].additionalProperties).toBe(false);
    }
    expect(EVIDENCE_SCHEMAS.intent_link.required).toEqual(['repo', 'number', 'title']);
    expect(EVIDENCE_SCHEMAS.intent_ship.required).toEqual(['release']);
  });

  it('mcp-evidence re-exports the identical objects, never copies', () => {
    expect(mcpEvidence.EVIDENCE_SCHEMAS).toBe(EVIDENCE_SCHEMAS);
    expect(mcpEvidence.validEvidenceArgs).toBe(validEvidenceArgs);
  });

  it('validEvidenceArgs accepts valid args and rejects malformed ones through schema.js', () => {
    expect(validEvidenceArgs('intent_link', link)).toBe(true);
    expect(validEvidenceArgs('intent_ship', ship)).toBe(true);
    expect(validEvidenceArgs('intent_link', { ...link, sneaky: 1 })).toBe(false);
    expect(validEvidenceArgs('intent_link', { ...link, number: 1.5 })).toBe(false);
    expect(validEvidenceArgs('intent_link', { ...link, repo: 'not a repo' })).toBe(false);
    expect(validEvidenceArgs('intent_ship', { notes: 'no release' })).toBe(false);
    expect(validEvidenceArgs('intent_ship', { ...ship, at: 'yesterday' })).toBe(false);
    expect(validEvidenceArgs('intent_link', 'string')).toBe(false);
    expect(validEvidenceArgs('intent_link', null)).toBe(false);
  });

  it('schema.ts keeps the purity invariant: no store, handler or I/O imports', () => {
    const source = readFileSync(join(here, '../src/core/intent/schema.ts'), 'utf8');
    const imports = [...source.matchAll(/^import .*from '([^']+)';$/gm)].map(m => m[1]);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/store|release\.js|connectors|node:/);
    }
    expect(imports).toContain('./evidence.js');
  });
});
