/**
 * growth/capability-gaps-model.ts — view model for the Capability gaps panel.
 * Reads the static capability audit catalog (pure, no Node APIs) and shapes
 * the headline, the per-domain strip, the top draftable gaps and the held
 * count. Only `implementableNow` gaps are ever draftable.
 */
import {
  buildCapabilityAudit,
  type CapabilityAuditReport,
  type CapabilityDomain,
  type CapabilityGap,
  type CapabilitySurface,
} from '../../../../core/fleet/capability-audit.js';
import type { DropJobDraft } from '../fleet-queue/drop-job-model.js';

export const TOP_GAP_LIMIT = 5;

export interface DomainCounts { domain: CapabilityDomain; parity: number; partial: number; gap: number }
export interface GapRow { id: string; domain: CapabilityDomain; leverage: number; summary: string; draft: DropJobDraft }
export interface CapabilityGapsView {
  total: number;
  parity: number;
  partial: number;
  headline: string;
  domains: DomainCounts[];
  top: GapRow[];
  held: number;
  heldLine: string;
}

/** Surfaces the hard limits keep out of reach: never draftable. */
const isHeld = (s: CapabilitySurface) => s.status === 'deferred' || s.status === 'gates-held';

export function draftBody(surface: CapabilitySurface): string {
  return [
    `Close the capability gap "${surface.id}" (${surface.domain}).`,
    '',
    `Surface id: ${surface.id}`,
    `Human: ${surface.human}`,
    `Agent today: ${surface.agent}`,
    `Route: ${surface.route}`,
    `Notes: ${surface.notes}`,
    '',
    'Make the agent route reach parity with the human action. Add a new test file covering the change.',
  ].join('\n');
}

export function draftFor(surface: CapabilitySurface): DropJobDraft {
  const id = `CAPGAP${surface.id.replace(/[^a-z0-9]/gi, '').toUpperCase()}`.slice(0, 40);
  return { id, lane: 'codex-personal', tier: 'mid', body: draftBody(surface) };
}

function toRow(gap: CapabilityGap, surfaces: Map<string, CapabilitySurface>): GapRow | null {
  const surface = surfaces.get(gap.id);
  if (!surface || isHeld(surface) || !gap.implementNow) return null;
  return { id: gap.id, domain: gap.domain, leverage: gap.leverage, summary: gap.summary, draft: draftFor(surface) };
}

export function capabilityGapsView(report: CapabilityAuditReport = buildCapabilityAudit()): CapabilityGapsView {
  const surfaces = new Map(report.surfaces.map(s => [s.id, s]));
  const byDomain = new Map<CapabilityDomain, DomainCounts>();
  for (const s of report.surfaces) {
    const row = byDomain.get(s.domain) ?? { domain: s.domain, parity: 0, partial: 0, gap: 0 };
    if (s.status === 'parity') row.parity++;
    else if (s.status === 'partial') row.partial++;
    else if (s.status === 'gap') row.gap++;
    byDomain.set(s.domain, row);
  }
  const top = report.implementableNow
    .map(g => toRow(g, surfaces))
    .filter((r): r is GapRow => r !== null)
    .slice(0, TOP_GAP_LIMIT);
  const { parity, partial, surfaces: total } = report.counts;
  const held = report.counts.deferred + report.counts.gatesHeld;
  return {
    total,
    parity,
    partial,
    headline: `Phantom can do ${parity} of ${total} things you can do on this Mac; ${partial} more are partial.`,
    domains: [...byDomain.values()],
    top,
    held,
    heldLine: `${held} held by hard limits (secrets, money, outside sends, data deletion)`,
  };
}
