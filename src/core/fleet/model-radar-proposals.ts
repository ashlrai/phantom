import { createProposal, listProposals } from '../inbox/store.js';
import type { ModelRadarReport, ModelRegistryPatch } from './model-radar.js';

const PREFIX = '[model radar] Review ';

export function fileModelRadarProposals(report: ModelRadarReport): NonNullable<ModelRadarReport['proposals']> {
  const result: NonNullable<ModelRadarReport['proposals']> = { filed: [], existing: [], failed: 0 };
  if (!report.patch.add.length || report.error) return result;
  const evidence = new Map(report.new_models.map(item => [`${item.provider}:${item.id}`, item]));
  const seen = new Map(listProposals().filter(row =>
    row.origin === 'manual' && row.kind === 'note' && row.repo === null && row.title.startsWith(PREFIX),
  ).map(row => [row.title, row.id]));
  for (const entry of report.patch.add) {
    const key = `${entry.provider}:${entry.id}`, candidate = evidence.get(key);
    if (!candidate?.source_url || !candidate.retrieved_on) continue;
    const title = `${PREFIX}${key}`, existing = seen.get(title);
    if (existing) { result.existing.push(existing); continue; }
    const patch: ModelRegistryPatch = { ...report.patch, add: [entry], retire: [], rename: [] };
    const proposal = createProposal({
      repo: null, origin: 'manual', kind: 'note', title,
      summary: [
        'Review this official-source candidate for Phantom’s docs/model-registry.json. A shape match is not verification; the row stays unverified.',
        `Source: ${candidate.source_url} (retrieved ${candidate.retrieved_on}, line ${candidate.line_number})`,
        `Evidence (quoted): ${JSON.stringify(candidate.line)}`,
        `Unapplied registry patch: ${JSON.stringify(patch)}`,
      ].join('\n'),
    });
    if (proposal.status === 'pending') {
      seen.set(title, proposal.id);
      result.filed.push(proposal.id);
    } else {
      result.failed++;
    }
  }
  return result;
}
