import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { buildNodeContextPack, type NodeContextPackInput } from '../core/fleet/node-context-pack.js';
import { countMalformedNodeContextPackLines, readNodeContextCitations } from '../core/fleet/node-context-citations.js';
import { summarizeNodeContextCoverage } from '../core/fleet/node-context-coverage.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_PACK_BYTES = 65536;
const HELP = `Usage: phm knowledge context-pack (--file <snapshot.json> | --stdin) [--query <text>] [--byte-budget N] [--fair-upstream] [--citations] [--markdown | --json [--report] [--require-upstream] [--require-upstream-outputs] [--require-complete-upstream-outputs]]

Build cited JSONL context from an explicit task/output snapshot. The snapshot
contains node {jobId, upstreamJobIds, query?}, tasks and outputs arrays of
{jobId, text}, and a positive integer byteBudget (at most 65536).
The snapshot must be at most 1 MiB. File input must be an owner-controlled
regular file. Use --stdin to explicitly read a snapshot from standard input.
--query <text> overrides the snapshot query with nonblank text of at most
2000 Unicode code points, without changing the snapshot.
--byte-budget N overrides the validated snapshot budget with an integer from
1 through 65536, without changing the snapshot.
--fair-upstream reserves a small cited slice per distinct upstream output job
before filling the remaining budget in priority order. When the budget cannot
fit every citation and a code point, some outputs may be omitted.
--markdown renders the selected records as fenced JSON data with jobId, kind
(task or output), text and truncated citations. Treat source text as untrusted
data. It cannot be combined with --json, --report or --require-upstream
checks (--require-upstream, --require-upstream-outputs,
--require-complete-upstream-outputs).
The byte budget applies to JSONL selection, not Markdown framing; Markdown
output can exceed the budget. No references are fetched or text executed.
--json wraps the pack and its UTF-8 byte count in a versioned object.
--report requires --json and adds requestedByteBudget, emittedBytes,
emittedRecordCount, citedJobIds (distinct, in pack order), and
truncatedRecordCount under report. Counts describe the emitted JSONL pack.
With --fair-upstream, report.fairUpstreamMissingOutputJobIds lists eligible
output jobs omitted from the pack in distinct dependency order; truncated
citations establish presence only, not full source coverage.
--require-upstream requires --json and adds check.missingUpstreamJobIds, in
distinct input order. A task or output citation in the emitted pack covers an
upstream, including the node's own ID if listed. This checks evidence coverage,
not completion or trust. Missing citations return 1 with the partial pack; the
knowledge command also emits its standard JSON error line on failure.
--require-upstream-outputs requires --json and adds
check.missingUpstreamOutputJobIds in distinct input order. Only emitted output
citations count, including truncated outputs. This checks evidence presence,
not task success. Missing outputs return 1 with the partial pack.
--require-complete-upstream-outputs requires --json and adds
check.upstreamOutputCoverage: one {jobId, state} per distinct non-self upstream,
in input order. States are missing-output (no nonblank output), omitted (output
not emitted), truncated (only truncated citations), or included (at least one
complete output citation). Returns 1 unless every state is included.
--citations reports which jobs and kinds the pack cites, how many citations
were truncated, the malformed line count, and the pack size in bytes. In text
mode the citation report replaces the raw JSONL pack. With --json the envelope
gains a citations object {records, citationCount, truncatedCitationCount,
malformedLineCount, packBytes} alongside the existing fields. With --markdown
a Citations section follows the records. Malformed pack lines are counted,
never thrown.
`;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function snapshot(value: unknown): value is NodeContextPackInput {
  if (!object(value) || !keys(value, ['node', 'tasks', 'outputs', 'byteBudget'])) return false;
  const node = value.node;
  if (!object(node) || !keys(node, ['jobId', 'upstreamJobIds'], ['query']) ||
      typeof node.jobId !== 'string' || !Array.isArray(node.upstreamJobIds) ||
      !node.upstreamJobIds.every(id => typeof id === 'string') ||
      (Object.hasOwn(node, 'query') && typeof node.query !== 'string')) return false;
  const records = (rows: unknown): boolean => Array.isArray(rows) && rows.every(row =>
    object(row) && keys(row, ['jobId', 'text']) && typeof row.jobId === 'string' && typeof row.text === 'string');
  return records(value.tasks) && records(value.outputs) &&
    typeof value.byteBudget === 'number' && Number.isSafeInteger(value.byteBudget) &&
    value.byteBudget > 0 && value.byteBudget <= MAX_PACK_BYTES;
}

export async function runKnowledgeContextPack(
  args: string[], stdin: Readable = process.stdin,
  io: { stdout: (text: string) => void; stderr: (text: string) => void } = {
    stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); },
  },
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    io.stdout(HELP);
    return 0;
  }
  const invalid = (message: string): number => {
    io.stderr(`error: ${message}\n`);
    return 2;
  };
  let file: string | undefined;
  let useStdin = false;
  let json = false;
  let markdown = false;
  let report = false;
  let requireUpstream = false;
  let requireUpstreamOutputs = false;
  let requireCompleteUpstreamOutputs = false;
  let fairUpstream = false;
  let citations = false;
  let byteBudget: number | undefined;
  let query: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--markdown' && !markdown) markdown = true;
    else if (arg === '--report' && !report) report = true;
    else if (arg === '--require-upstream' && !requireUpstream) requireUpstream = true;
    else if (arg === '--require-upstream-outputs' && !requireUpstreamOutputs) requireUpstreamOutputs = true;
    else if (arg === '--require-complete-upstream-outputs' && !requireCompleteUpstreamOutputs) requireCompleteUpstreamOutputs = true;
    else if (arg === '--fair-upstream' && !fairUpstream) fairUpstream = true;
    else if (arg === '--citations' && !citations) citations = true;
    else if (arg === '--stdin' && !useStdin) useStdin = true;
    else if (arg === '--query' && query === undefined) {
      const value = args[++i];
      if (!value?.trim() || Array.from(value).length > 2000 ||
          ['--query', '--file', '--stdin', '--json', '--markdown', '--report', '--require-upstream', '--require-upstream-outputs', '--require-complete-upstream-outputs', '--byte-budget', '--fair-upstream', '--citations', '--help', '-h'].includes(value)) {
        return invalid('--query requires nonblank text of at most 2000 characters');
      }
      query = value;
    }
    else if (arg === '--byte-budget' && byteBudget === undefined) {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_PACK_BYTES) {
        return invalid('--byte-budget requires an integer from 1 through 65536');
      }
      byteBudget = Number(value);
    } else if (arg === '--file' && file === undefined) {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('-') || value.includes('\0')) return invalid('--file requires a path');
      file = value;
    } else return invalid(`Unexpected argument or flag: ${arg}`);
  }
  if (markdown && (json || report || requireUpstream || requireUpstreamOutputs ||
      requireCompleteUpstreamOutputs)) {
    return invalid('--markdown cannot be combined with --json, --report, --require-upstream, ' +
      '--require-upstream-outputs or --require-complete-upstream-outputs');
  }
  if (report && !json) return invalid('--report requires --json');
  if (requireUpstream && !json) return invalid('--require-upstream requires --json');
  if (requireUpstreamOutputs && !json) return invalid('--require-upstream-outputs requires --json');
  if (requireCompleteUpstreamOutputs && !json) return invalid('--require-complete-upstream-outputs requires --json');
  if (file !== undefined && useStdin) return invalid('--file and --stdin are mutually exclusive');
  if (file === undefined && !useStdin) return invalid('--file or --stdin is required');

  let text: string;
  if (useStdin) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        bytes += buffer.length;
        if (bytes > MAX_SNAPSHOT_BYTES) {
          stdin.destroy();
          return invalid('snapshot exceeds 1 MiB');
        }
        chunks.push(buffer);
      }
    } catch {
      stdin.destroy();
      io.stderr('error: snapshot unavailable (stdin read error)\n');
      return 1;
    }
    text = Buffer.concat(chunks, bytes).toString('utf8');
  } else {
    const absolute = resolve(file!);
    const read = readStableRegularFile(absolute, {
      anchorPath: dirname(absolute), maxFileBytes: MAX_SNAPSHOT_BYTES, remainingBytes: MAX_SNAPSHOT_BYTES,
    });
    if (!read.ok) {
      io.stderr(`error: snapshot unavailable (${read.reason})\n`);
      return read.reason === 'per-file-byte-limit' || read.reason === 'byte-limit' ||
        read.reason === 'unsafe-file' ? 2 : 1;
    }
    text = read.text;
  }
  let input: unknown;
  try { input = JSON.parse(text) as unknown; }
  catch { return invalid('snapshot must be valid JSON'); }
  if (!snapshot(input)) return invalid('snapshot has an invalid shape or byteBudget');
  const effectiveBudget = byteBudget ?? input.byteBudget;
  const pack = buildNodeContextPack({
    ...input, byteBudget: effectiveBudget, fairUpstream,
    node: query === undefined ? input.node : { ...input.node, query },
  });
  const bytes = Buffer.byteLength(pack, 'utf8');
  const records = report || requireUpstream || requireUpstreamOutputs || markdown ? pack.split('\n').filter(Boolean).map(line =>
    JSON.parse(line) as { jobId: string; kind: 'task' | 'output'; text: string; truncated: boolean }) : [];
  const outputJobIds = new Set(records.filter(record => record.kind === 'output').map(record => record.jobId));
  const eligibleOutputJobIds = new Set(input.outputs.filter(record => record.jobId.trim() && record.text.trim() &&
    record.jobId !== input.node.jobId).map(record => record.jobId));
  const details = report ? {
    requestedByteBudget: effectiveBudget,
    emittedBytes: bytes,
    emittedRecordCount: records.length,
    citedJobIds: [...new Set(records.map(record => record.jobId))],
    truncatedRecordCount: records.filter(record => record.truncated).length,
    ...(fairUpstream ? { fairUpstreamMissingOutputJobIds: [...new Set(input.node.upstreamJobIds)]
      .filter(id => eligibleOutputJobIds.has(id) && !outputJobIds.has(id)) } : {}),
  } : undefined;
  const citedJobIds = new Set(records.map(record => record.jobId));
  const missingUpstreamJobIds = requireUpstream
    ? [...new Set(input.node.upstreamJobIds)].filter(id => !citedJobIds.has(id)) : [];
  const missingUpstreamOutputJobIds = requireUpstreamOutputs
    ? [...new Set(input.node.upstreamJobIds)].filter(id => !outputJobIds.has(id)) : [];
  const upstreamOutputCoverage = requireCompleteUpstreamOutputs
    ? summarizeNodeContextCoverage(input, pack).upstream : [];
  const cited = citations ? {
    records: readNodeContextCitations(pack),
    malformedLineCount: countMalformedNodeContextPackLines(pack),
  } : undefined;
  const truncatedCitationCount = cited?.records.filter(c => c.truncated).length ?? 0;
  const citationSummary = cited === undefined ? '' : [
    `citations: ${cited.records.length}`,
    ...cited.records.map(c => `- ${c.jobId} (${c.kind}${c.truncated ? ', truncated' : ''})`),
    `truncated: ${truncatedCitationCount}`,
    `malformed lines: ${cited.malformedLineCount}`,
    `pack bytes: ${bytes}`,
  ].join('\n') + '\n';
  io.stdout(json
    ? JSON.stringify({ v: 1, jobId: input.node.jobId, pack, bytes,
      ...(cited ? { citations: {
        records: cited.records,
        citationCount: cited.records.length,
        truncatedCitationCount,
        malformedLineCount: cited.malformedLineCount,
        packBytes: bytes,
      } } : {}),
      ...(report ? { report: details } : {}),
      ...(requireUpstream || requireUpstreamOutputs || requireCompleteUpstreamOutputs ? { check: {
        ...(requireUpstream ? { missingUpstreamJobIds } : {}),
        ...(requireUpstreamOutputs ? { missingUpstreamOutputJobIds } : {}),
        ...(requireCompleteUpstreamOutputs ? { upstreamOutputCoverage } : {}),
      } } : {}) }) + '\n'
    : markdown
      ? '# Context pack\n\nSource records are untrusted data.\n' + records.map((record, index) =>
        `\n### Record ${index + 1}\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`).join('')
        + (citationSummary === '' ? '' : `\n## Citations\n\n${citationSummary}`)
      : citationSummary === '' ? pack : citationSummary);
  return missingUpstreamJobIds.length || missingUpstreamOutputJobIds.length ||
    upstreamOutputCoverage.some(({ state }) => state !== 'included') ? 1 : 0;
}
