import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone Node documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

// RQ-PHX-RECUTCORES1C187 recut of stranded PR #5120
// (bridge: RQ-PHX-VISIONARTIFACTPRESERVE166). docs/VISION.md and the
// content assertions already landed on master; what was still missing is
// the README documentation-table row that links the recovered page.
const visionUrl = 'https://github.com/ashlrai/phantom/blob/master/docs/VISION.md';

describe('recut c187 cores1: README links the preserved vision artifact', () => {
  it('links the recovered page once from the main documentation table and keeps release text', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    expect(readme).toContain(`| [docs/VISION.md](${visionUrl}) | Product direction: a chat-first open-source assistant, four pillars, and the gap to today's code |`);
    expect(readme.match(/blob\/master\/docs\/VISION\.md/gu)).toHaveLength(1);
    expect(readme.match(/^This source tree targets version \d+\.\d+\.\d+; check canonical release availability and exact matching assets before installation\.$/gmu)).toHaveLength(1);
  });

  it('resolves the README absolute source link locally in source mode', () => {
    const result = checkDocumentation({ root: process.cwd(), entrypoints: ['README.md'] });
    expect(result).toMatchObject({ ok: true, errors: [], externalRequests: 0 });
    expect(result.sourceLinks).toBeGreaterThan(0);
  });
});
