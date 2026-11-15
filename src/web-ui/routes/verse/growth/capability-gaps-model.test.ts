import { expect, it } from 'vitest';
import { buildCapabilityAudit, CAPABILITY_SURFACES } from '../../../../core/fleet/capability-audit.js';
import { validateDraft } from '../fleet-queue/drop-job-model.js';
import { capabilityGapsView, TOP_GAP_LIMIT } from './capability-gaps-model.js';

const report = buildCapabilityAudit(new Date('2026-11-09T00:00:00Z'));
const view = capabilityGapsView(report);

it('counts per domain add up to the catalog', () => {
  for (const d of view.domains) {
    const of = (status: string) => CAPABILITY_SURFACES.filter(s => s.domain === d.domain && s.status === status).length;
    expect(d).toMatchObject({ parity: of('parity'), partial: of('partial'), gap: of('gap') });
  }
  expect(view.domains.reduce((n, d) => n + d.partial, 0)).toBe(report.counts.partial);
  expect(view.headline).toBe(`Phantom can do ${report.counts.parity} of ${report.counts.surfaces} things you can do on this Mac; ${report.counts.partial} more are partial.`);
});

it('top rows follow the audit order, capped at five', () => {
  expect(view.top.length).toBe(Math.min(TOP_GAP_LIMIT, report.implementableNow.length));
  expect(view.top.map(r => r.id)).toEqual(report.implementableNow.slice(0, TOP_GAP_LIMIT).map(g => g.id));
});

it('held surfaces are never draftable and are counted', () => {
  const held = new Set(CAPABILITY_SURFACES.filter(s => s.status === 'deferred' || s.status === 'gates-held').map(s => s.id));
  expect(view.held).toBe(held.size);
  expect(view.top.some(r => held.has(r.id))).toBe(false);
});

it('drafts are valid, name the surface and ask for a test file', () => {
  for (const row of view.top) {
    expect(validateDraft(row.draft).ok).toBe(true);
    expect(row.draft.body).toContain(`Surface id: ${row.id}`);
    expect(row.draft.body).toContain('new test file');
  }
});
