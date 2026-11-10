/**
 * recut-pr2831.test.ts — recut of PR #2831 (RQ-DRAIN-phantom-1019): product
 * direction consolidated into docs/VISION.md, NORTH-STAR.md reduced to the
 * prompt-loader stub, packaged guides retargeted to the vision page.
 *
 * Drives the recovered behavior through its real entry points:
 *   - scripts/check-documentation.mjs resolves docs/VISION.md and every link
 *     the retargeted guides now make;
 *   - src/core/ecosystem/map.ts northStarDocSummary() still extracts the
 *     vision line and the three pillar names from the stub it parses;
 *   - the capability map's cited src/ paths exist on this checkout.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone Node documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';
import { _resetNorthStarDocCache, northStarDocSummary } from '../src/core/ecosystem/map.js';

const root = process.cwd();
const vision = readFileSync(join(root, 'docs/VISION.md'), 'utf8');
const northStar = readFileSync(join(root, 'docs/NORTH-STAR.md'), 'utf8');

describe('docs/VISION.md — product direction page (recut of #2831)', () => {
  it('resolves through the real documentation checker with no external requests', () => {
    expect(checkDocumentation({ root, entrypoints: ['docs/VISION.md'] }))
      .toMatchObject({ ok: true, errors: [], externalRequests: 0 });
  });

  it('keeps the four pillars, the capability map and the ranked top gaps', () => {
    for (const heading of [
      '### 1. Assistant UX',
      '### 2. Provider-agnostic',
      '### 3. Connect any resource',
      '### 4. Proactive and fully autonomous',
    ]) {
      expect(vision).toContain(heading);
    }
    expect(vision).toContain('## The four pillars');
    expect(vision).toContain('| Capability | Pillar | Status |');
    expect(vision).toContain('## Top gaps');
    expect(vision).toContain('## Code follow-ups');
  });

  it('cites only src/ paths that exist on this checkout', () => {
    const cited = new Set(vision.match(/src\/[a-zA-Z0-9/_.-]+/g) ?? []);
    expect(cited.size).toBeGreaterThan(20);
    for (const path of cited) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }
  });

  it('is the linked direction target from the shipped README table', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('docs/VISION.md');
  });
});

describe('docs/NORTH-STAR.md — loader stub preserved on master', () => {
  it('still feeds northStarDocSummary() the vision line and three pillar names', () => {
    _resetNorthStarDocCache();
    const summary = northStarDocSummary();
    expect(summary).toContain('NORTH-STAR');
    expect(summary).toContain('Build Phantom into an agent-native operating system');
    expect(summary).toMatch(/recursive self.?improvement/i);
    expect(summary).toMatch(/ecosystem product factory/i);
    expect(summary).toMatch(/composition/i);
  });

  it('points readers at VISION.md and keeps the VISION-NEXT link the plan test requires', () => {
    expect(northStar).toContain('docs/VISION.md');
    expect(northStar).toContain('https://github.com/ashlrai/phantom/blob/master/docs/VISION-NEXT.md');
    expect(northStar).toMatch(/Historical\/design context/i);
    expect(northStar).toContain('loader stub');
  });
});

describe('retargeted guides resolve on the real checkout', () => {
  it.each([
    'docs/ARCHITECTURE.md',
    'docs/ASHLR-UNIVERSE.md',
    'docs/DEMO.md',
    'docs/HUB-REFERENCE.md',
    'docs/NORTH-STAR.md',
    'docs/PROACTIVE-COORDINATION.md',
    'docs/ROADMAP.md',
  ])('%s links pass the documentation checker', (guide) => {
    const result = checkDocumentation({ root, entrypoints: [guide] });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('every retargeted guide actually links the vision page', () => {
    for (const guide of [
      'docs/ARCHITECTURE.md',
      'docs/ASHLR-UNIVERSE.md',
      'docs/DEMO.md',
      'docs/HUB-REFERENCE.md',
      'docs/NORTH-STAR.md',
      'docs/PROACTIVE-COORDINATION.md',
      'docs/PROACTIVE-COORDINATION-BACKLOG.md',
      'docs/ROADMAP.md',
      'docs/ROADMAP-NEXT.md',
      'docs/SPEC-ELON-DIRECTOR.md',
      'docs/UNIVERSE-AUTONOMY-RESEARCH.md',
      'docs/ambitious-fleet-os-v1.md',
      'docs/IMPROVEMENT-BACKLOG.md',
    ]) {
      expect(readFileSync(resolve(root, guide), 'utf8'), guide).toMatch(/VISION\.md/);
    }
  });
});
