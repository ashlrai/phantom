import { QUEUE_STATUSES, validateQueue, type QueueDocument, type QueueJob, type QueueRawLine, type QueueStatus } from './schema.js';

const statusSet = new Set<string>(QUEUE_STATUSES);
// Optional bullet, bold or bracket decoration, then an all-caps status token.
const statusPrefix = /^(\s*(?:(?:[-*]|\d+[.)])\s+)?(?:\*\*\s*)?\[?)([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)(?![A-Za-z0-9])/;
const idPattern = /RQ-[A-Za-z0-9][A-Za-z0-9._-]*/g;
const hasId = /RQ-[A-Za-z0-9]/;
const bulletish = /^\s*(?:(?:[-*]|\d+[.)])\s)/;
// Keywords whose following run of RQ-* tokens names dependencies (never the job id).
const depKeywords = /\b(?:deps?|depends?(?:\s+on)?|after|waits?[- ]?for|waiting[- ]?(?:for|on)|blocked[- ]?by|needs?|requires?|prereq(?:uisites?)?)\b[\s:=]*/gi;
// Keywords whose RQ-* tokens name related jobs that are not the id and not deps.
const relatedKeywords = /\b(?:children|splits?[- ]?into|parents?)\b[\s:=]*/gi;
const separators = /^[\s,+|();]*/;
const poolToken = /^(codex-[a-z0-9-]+|devin|local)$/;

interface ParsedLine {
  statusWord: string;
  statusStart: number;
  statusEnd: number;
  known: boolean;
  id?: string;
  fields: string;
  body: string;
  /** Non-field text after the id inside the header (before the body colon). */
  residue: string;
  /** Non-field text between status and id. */
  preamble: string;
  unbalanced: boolean;
}

/** Balanced-paren scan: groups become private-use placeholders so inner ':' and 'RQ-*' never leak into header parsing. */
function skeletonize(rest: string): { skeleton: string; groups: string[]; unbalanced: boolean } {
  let skeleton = '';
  const groups: string[] = [];
  let depth = 0;
  let open = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '(') { if (depth === 0) open = i; depth++; }
    else if (ch === ')' && depth > 0) {
      depth--;
      if (depth === 0) {
        groups.push(rest.slice(open + 1, i));
        skeleton += `\uE000${groups.length - 1}\uE000`;
      }
    } else if (depth === 0) skeleton += ch;
  }
  if (depth > 0) skeleton += rest.slice(open); // unclosed '(' stays literal
  return { skeleton, groups, unbalanced: depth > 0 };
}

/** Start offsets of RQ-* tokens that follow a keyword run (deps, children, parent); never the job id. */
function keywordObjectPositions(text: string): Set<number> {
  const positions = new Set<number>();
  for (const keywords of [depKeywords, relatedKeywords]) {
    for (const match of text.matchAll(keywords)) {
      let i = match.index + match[0].length;
      for (;;) {
        i += (text.slice(i).match(separators))![0].length;
        const token = text.slice(i).match(/^RQ-[A-Za-z0-9][A-Za-z0-9._-]*/);
        if (!token) break;
        positions.add(i);
        i += token[0].length;
      }
    }
  }
  return positions;
}

const expandGroups = (segment: string, groups: string[]): string =>
  segment.replace(/\uE000(\d+)\uE000/g, (_, i) => `(${groups[Number(i)]})`);
const collapse = (segment: string): string => segment.replace(/\uE000\d+\uE000/g, ' ').replace(/[*[\]]+/g, ' ').replace(/\s+/g, ' ').trim();

function parseLine(line: string): ParsedLine | null {
  const prefix = line.match(statusPrefix);
  if (!prefix) return null;
  const statusWord = prefix[2];
  const statusStart = prefix[1].length;
  const statusEnd = statusStart + statusWord.length;
  const known = statusSet.has(statusWord);
  if (!known) return { statusWord, statusStart, statusEnd, known, fields: '', body: '', residue: '', preamble: '', unbalanced: false };
  const rest = line.slice(statusEnd);
  const { skeleton, groups, unbalanced } = skeletonize(rest);
  const keywordObjects = keywordObjectPositions(skeleton);
  const tokens = [...skeleton.matchAll(idPattern)].map(m => ({ text: m[0], start: m.index ?? 0, keyword: keywordObjects.has(m.index ?? -1) }));
  // Header ends at the first ':' after the first RQ- token; the job id is its last non-keyword token.
  let headerEnd = -1;
  if (tokens.length) {
    const colon = skeleton.indexOf(':', tokens[0].start + tokens[0].text.length);
    headerEnd = colon === -1 ? skeleton.length : colon;
  }
  const header = headerEnd === -1 ? '' : skeleton.slice(0, headerEnd);
  const idToken = tokens.filter(t => !t.keyword && t.start < header.length).at(-1);
  const fieldGroups = groups.filter((_, i) => header.includes(`\uE000${i}\uE000`));
  const result: ParsedLine = {
    statusWord, statusStart, statusEnd, known,
    fields: fieldGroups.join(', '),
    body: headerEnd === -1 || headerEnd >= skeleton.length ? '' : expandGroups(skeleton.slice(headerEnd + 1), groups).trim(),
    residue: '', preamble: '', unbalanced,
  };
  if (idToken) {
    result.id = idToken.text;
    result.residue = collapse(header.slice(idToken.start + idToken.text.length));
    result.preamble = collapse(header.slice(0, idToken.start));
  }
  return result;
}

const fieldIn = (text: string, name: string): string | undefined =>
  text.match(new RegExp(`(?:^|[,;\\n]\\s*)${name}\\s*=\\s*([^,;\\n]+)`, 'i'))?.[1].trim();

function extractDeps(text: string, id: string): { deps: string[]; selfDep: boolean } {
  const deps = new Set<string>();
  let selfDep = false;
  for (const match of text.matchAll(depKeywords)) {
    let i = match.index + match[0].length;
    for (;;) {
      i += (text.slice(i).match(separators))![0].length;
      const token = text.slice(i).match(/^RQ-[A-Za-z0-9][A-Za-z0-9._-]*/);
      if (!token) break;
      if (token[0] === id) selfDep = true; else deps.add(token[0]);
      i += token[0].length;
    }
  }
  return { deps: [...deps], selfDep };
}

function parseJob(line: string, parsed: ParsedLine & { id: string }): { job: QueueJob; selfDep: boolean } {
  const whole = [parsed.fields, parsed.preamble, parsed.residue, parsed.body].join('\n');
  const field = (name: string): string | undefined => fieldIn(whole, name);
  const routing = (name: string): string | undefined => fieldIn(parsed.fields, name);
  const acceptance = /\bAcceptance:\s*/i.exec(parsed.body);
  const bodyScope = (acceptance ? parsed.body.slice(0, acceptance.index) : parsed.body).trim();
  const owner = field('worker') ?? field('owner');
  const claimedAt = field('claimed') ?? field('claimed[-_]?at');
  const { deps, selfDep } = extractDeps(whole, parsed.id);
  const job: QueueJob = {
    id: parsed.id,
    status: parsed.statusWord as QueueStatus,
    priority: routing('priority') ?? parsed.fields.match(/\bP\d+\b/)?.[0] ?? 'P2',
    pool: routing('pool') ?? parsed.preamble.split(' ').find(token => poolToken.test(token)) ?? 'unspecified',
    tier: routing('tier') ?? 'unspecified',
    repo: routing('repo') ?? 'unspecified',
    deps,
    scope: bodyScope || parsed.residue || line.slice(parsed.statusEnd).trim(),
    acceptance: acceptance ? parsed.body.slice(acceptance.index + acceptance[0].length).trim() : '',
    claims: [],
  };
  if (owner && claimedAt && /^\d{4}-\d\d-\d\dT/.test(claimedAt) && Number.isFinite(Date.parse(claimedAt))) job.claims.push({ owner, claimedAt });
  const prUrl = line.match(/https:\/\/[^\s<>"'()]+\/pull\/\d+/)?.[0] ?? field('pr');
  if (prUrl && /^https:\/\/[^\s]+$/.test(prUrl)) job.prUrl = prUrl;
  const reason = field('reason') ?? field('blocked[-_]?reason') ?? field('blocked');
  if ((parsed.statusWord === 'BLOCKED' || parsed.statusWord === 'HOLD') && (reason || parsed.preamble)) job.blockedReason = reason ?? parsed.preamble;
  return { job, selfDep };
}

/** Job-shaped lines never throw: unknown statuses, missing ids and duplicates degrade to raw records with warnings. */
export function importMarkdown(text: string): QueueDocument {
  const jobs: QueueJob[] = [];
  const raw: QueueRawLine[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  const keep = (index: number, warning: string): void => {
    raw.push({ line: index + 1, text: lines[index], warning });
    warnings.push(`line ${index + 1}: ${warning}`);
  };
  for (const [index, line] of lines.entries()) {
    const parsed = parseLine(line);
    const jobish = bulletish.test(line) || hasId.test(line);
    if (!parsed) { if (jobish) keep(index, 'unrecognized job line'); continue; }
    if (!parsed.known) { if (jobish) keep(index, `unknown status "${parsed.statusWord}"`); continue; }
    if (!parsed.id) { keep(index, 'job id not found (expected RQ-*)'); continue; }
    if (seen.has(parsed.id)) { keep(index, `duplicate job id "${parsed.id}"`); continue; }
    seen.add(parsed.id);
    const { job, selfDep } = parseJob(line, parsed as ParsedLine & { id: string });
    jobs.push(job);
    if (selfDep) warnings.push(`line ${index + 1}: ${job.id} dropped self-dependency`);
    if (parsed.unbalanced) warnings.push(`line ${index + 1}: unbalanced parenthesis`);
  }
  const doc: QueueDocument = {
    schema: 'queue.v1', jobs,
    ...(raw.length ? { raw } : {}),
    ...(warnings.length ? { warnings } : {}),
    source: { text, jobs: structuredClone(jobs) },
  };
  validateQueue(doc);
  return doc;
}

const metadataFor = (job: QueueJob): string => job.claims.length || job.prUrl || job.blockedReason
  ? ` <!-- queue.v1 ${JSON.stringify({ claims: job.claims, prUrl: job.prUrl, blockedReason: job.blockedReason }).replace(/--/g, '\\u002d\\u002d')} -->` : '';
const lineFor = (job: QueueJob): string => `- ${job.status} ${job.id} (priority=${job.priority}, pool=${job.pool}, tier=${job.tier}, repo=${job.repo}${job.deps.length ? `, deps=${job.deps.join('|')}` : ''}): ${job.scope.replace(/\r?\n/g, ' ')} Acceptance: ${job.acceptance.replace(/\r?\n/g, ' ')}${metadataFor(job)}`;
/** Byte-exact for unchanged imports. Edits retain all original prose and fields. */
export function exportMarkdown(doc: QueueDocument): string {
  validateQueue(doc);
  if (!doc.source) {
    const rendered = doc.jobs.map(lineFor).join('\n') + (doc.jobs.length ? '\n' : '');
    return rendered + (doc.raw?.length ? doc.raw.map(entry => entry.text).join('\n') + '\n' : '');
  }
  const seen = new Set<string>();
  const rawLines = new Set((doc.raw ?? []).map(entry => entry.line));
  const parts = doc.source.text.split(/(\r?\n)/);
  const rendered: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const eol = parts[i + 1] ?? '';
    const lineNumber = i / 2 + 1;
    let next = line;
    if (line && !rawLines.has(lineNumber)) {
      const parsed = parseLine(line);
      const job = parsed?.known && parsed.id ? doc.jobs.find(j => j.id === parsed.id) : undefined;
      if (parsed && job) {
        seen.add(job.id);
        const original = doc.source.jobs.find(j => j.id === job.id);
        // Preserve unknown fields, scope, acceptance and section context on state changes.
        if (JSON.stringify(job) !== JSON.stringify(original)) next = line.slice(0, parsed.statusStart) + job.status + line.slice(parsed.statusEnd) + metadataFor(job);
      }
    }
    rendered.push(next + eol);
  }
  let text = rendered.join('');
  for (const job of doc.jobs.filter(j => !seen.has(j.id))) text += `${text && !text.endsWith('\n') ? '\n' : ''}${lineFor(job)}\n`;
  return text;
}
