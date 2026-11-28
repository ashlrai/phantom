import { createProposal, listProposals } from '../inbox/store.js';
import type { ModelRadarItem, ModelRadarReport, ModelRegistryPatch } from './model-radar.js';

const PREFIX = '[model radar] Review ';

export function fileModelRadarProposals(report: ModelRadarReport): NonNullable<ModelRadarReport['proposals']> {
  const result: NonNullable<ModelRadarReport['proposals']> = { filed: [], existing: [], failed: 0 };
  const hasFindings = report.patch.add.length || report.patch.retire.length || report.patch.rename.length || report.lane_notices.length;
  if (report.error || !hasFindings) return result;
  const seen = new Map(listProposals().filter(row =>
    row.origin === 'manual' && row.kind === 'note' && row.repo === null && row.title.startsWith(PREFIX),
  ).map(row => [row.title, row.id]));
  const file = (title: string, summary: string) => {
    const existing = seen.get(title);
    if (existing) { result.existing.push(existing); return; }
    const proposal = createProposal({ repo: null, origin: 'manual', kind: 'note', title, summary });
    if (proposal.status === 'pending') {
      seen.set(title, proposal.id);
      result.filed.push(proposal.id);
    } else {
      result.failed++;
    }
  };
  // Only a fresh fetched page carries provenance; a finding read from an older
  // saved file cannot be quoted, so it stays in the report but files no note.
  const sourced = (item: ModelRadarItem | undefined) => item?.source_url && item.retrieved_on ? item : undefined;
  const evidenceLines = (item: ModelRadarItem) => [
    `Source: ${item.source_url} (retrieved ${item.retrieved_on}, line ${item.line_number})`,
    `Evidence (quoted): ${JSON.stringify(item.line)}`,
  ];
  const patchOf = (patch: ModelRegistryPatch) => JSON.stringify(patch);
  const added = new Map(report.new_models.map(item => [`${item.provider}:${item.id}`, item]));
  for (const entry of report.patch.add) {
    const key = `${entry.provider}:${entry.id}`, candidate = sourced(added.get(key));
    if (!candidate) continue;
    file(`${PREFIX}${key}`, [
      'Review this official-source candidate for Phantom’s docs/model-registry.json. A shape match is not verification; the row stays unverified.',
      ...evidenceLines(candidate),
      `Unapplied registry patch: ${patchOf({ ...report.patch, add: [entry], retire: [], rename: [] })}`,
    ].join('\n'));
  }
  const retired = new Map(report.retired_models.map(item => [`${item.provider}:${item.id}`, item]));
  for (const op of report.patch.retire) {
    const key = `${op.provider}:${op.id}`, candidate = sourced(retired.get(key));
    if (!candidate) continue;
    file(`${PREFIX}retire ${key}`, [
      `Review this official-source retirement for Phantom’s docs/model-registry.json: the provider’s release notes say ${op.id} was retired. The router already refuses retired registry entries, but the row stays listed until the patch is applied by hand.`,
      ...evidenceLines(candidate),
      `Unapplied registry patch: ${patchOf({ ...report.patch, add: [], retire: [op], rename: [] })}`,
    ].join('\n'));
  }
  const renamed = new Map(report.renamed.map(item => [`${item.provider}:${item.from}:${item.id}`, item]));
  for (const op of report.patch.rename) {
    const key = `${op.provider}:${op.from}`, candidate = sourced(renamed.get(`${key}:${op.to}`));
    if (!candidate) continue;
    file(`${PREFIX}rename ${key}`, [
      `Review this official-source rename for Phantom’s docs/model-registry.json: the provider’s release notes say ${op.from} is now ${op.to}. Renaming keeps the lane’s choice pointing at a current id.`,
      ...evidenceLines(candidate),
      `Unapplied registry patch: ${patchOf({ ...report.patch, add: [], retire: [], rename: [op] })}`,
    ].join('\n'));
  }
  const lanes = [...report.lane_notices].sort((a, b) => a.lane.localeCompare(b.lane) || a.id.localeCompare(b.id));
  for (const notice of lanes) {
    const title = `${PREFIX}lane ${notice.lane} ${notice.id}`;
    if (notice.status === 'mentioned') {
      const candidate = sourced(notice.evidence);
      if (!candidate) continue;
      file(title, [
        `Review configured lane ${notice.lane}: it routes to ${notice.id}, which provider release notes mention as retiring${candidate.confidence === 'low' ? ' (low confidence)' : ''}. The router keeps the lane’s choice until the model or the lane changes.`,
        ...evidenceLines(candidate),
      ].join('\n'));
    } else {
      file(title, [
        `Review configured lane ${notice.lane}: it routes to ${notice.id}, which the provider-docs confirmed list (models.docs.v1) marks ${notice.status}.${notice.replacement ? ` Provider docs name ${notice.replacement} as the replacement.` : ''} Verify with: phm models check --json`,
      ].join('\n'));
    }
  }
  return result;
}
