import { QUEUE_STATUSES, validateQueue, type QueueDocument, type QueueJob, type QueueStatus } from './schema.js';

const statusPattern = QUEUE_STATUSES.join('|');
// Accept bare status, [STATUS], and Markdown bold status/id in router bullets.
const linePattern = new RegExp(`^(\\s*(?:[-*]\\s+)?(?:\\*\\*)?\\[?)(${statusPattern})(\\]?(?:\\*\\*)?\\s*[:| -]?\\s*(?:\\*\\*)?)([A-Za-z0-9][A-Za-z0-9._-]*)(?:\\*\\*)?\\s*\\(([^)]*)\\)\\s*:?\\s*(.*)$`);
export function importMarkdown(text: string): QueueDocument {
  const jobs: QueueJob[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(linePattern);
    if (!match) {
      if (/^\s*[-*]?\s*(?:\*\*)?\[?(?:READY|CLAIMED|PR-OPEN|BLOCKED|HOLD|DONE|PROPOSED)\b/.test(line)) throw new Error('Malformed router job line');
      continue;
    }
    const [, , status, , id, fields, body] = match;
    const field = (name: string): string | undefined => fields.match(new RegExp(`(?:^|[,;]\\s*)${name}\\s*=\\s*([^,;]+)`, 'i'))?.[1].trim();
    const acceptance = /\bAcceptance:\s*/i.exec(body);
    const prUrl = body.match(/https:\/\/[^\s<>]+\/pull\/\d+/)?.[0];
    jobs.push({
      id, status: status as QueueStatus,
      priority: field('priority') ?? fields.match(/\bP\d+\b/)?.[0] ?? 'P2',
      pool: field('pool') ?? 'unspecified', tier: field('tier') ?? 'unspecified', repo: field('repo') ?? 'unspecified',
      deps: (field('deps') ?? '').split(/[\s|+]+/).filter(Boolean),
      scope: (acceptance ? body.slice(0, acceptance.index) : body).trim(),
      acceptance: acceptance ? body.slice(acceptance.index + acceptance[0].length) : '', claims: [],
      ...(prUrl ? { prUrl } : {}),
    });
  }
  const doc: QueueDocument = { schema: 'queue.v1', jobs, source: { text, jobs: structuredClone(jobs) } };
  validateQueue(doc);
  return doc;
}
const metadataFor = (job: QueueJob): string => job.claims.length || job.prUrl || job.blockedReason
  ? ` <!-- queue.v1 ${JSON.stringify({ claims: job.claims, prUrl: job.prUrl, blockedReason: job.blockedReason }).replace(/--/g, '\\u002d\\u002d')} -->` : '';
const lineFor = (job: QueueJob): string => `- ${job.status} ${job.id} (priority=${job.priority}, pool=${job.pool}, tier=${job.tier}, repo=${job.repo}${job.deps.length ? `, deps=${job.deps.join('|')}` : ''}): ${job.scope.replace(/\r?\n/g, ' ')} Acceptance: ${job.acceptance.replace(/\r?\n/g, ' ')}${metadataFor(job)}`;
/** Byte-exact for unchanged imports. Edits retain all original prose and fields. */
export function exportMarkdown(doc: QueueDocument): string {
  validateQueue(doc);
  if (!doc.source) return doc.jobs.map(lineFor).join('\n') + (doc.jobs.length ? '\n' : '');
  const seen = new Set<string>();
  let text = doc.source.text.replace(/[^\r\n]+/g, line => {
    const match = line.match(linePattern);
    if (!match) return line;
    const job = doc.jobs.find(j => j.id === match[4]);
    if (!job) return line;
    seen.add(job.id);
    const original = doc.source!.jobs.find(j => j.id === job.id);
    if (JSON.stringify(job) === JSON.stringify(original)) return line;
    // Preserve unknown fields, scope, acceptance and section context on state changes.
    return `${match[1]}${job.status}${line.slice(match[1].length + match[2].length)}` +
      metadataFor(job);
  });
  for (const job of doc.jobs.filter(j => !seen.has(j.id))) text += `${text && !text.endsWith('\n') ? '\n' : ''}${lineFor(job)}\n`;
  return text;
}
