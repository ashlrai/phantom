// After PR #6538 lands: node --import tsx workplans/metrics-asks-a3.mjs
// Uses its existing data and renderer; never creates a competing asks system.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import console from 'node:console';

const root = new URL('../', import.meta.url);
const data = new URL('src/core/fleet/mason-asks.ts', root);
const checker = new URL('src/core/fleet/mason-asks-check.ts', root);
const doc = new URL('docs/MASON-ASKS-STATUS.md', root);
const prerequisites = [data, checker, doc, new URL('src/cli/fleet-asks.ts', root)];
try { await Promise.all(prerequisites.map(path => readFile(path, 'utf8'))); }
catch { throw new Error('A3 update requires merged PR #6538; nothing written.'); }

const source = await readFile(data, 'utf8');
const { MASON_ASKS } = await import(data.href);
const { checkMasonAsks, readSourceIndex, renderMasonAsksMarkdown } = await import(checker.href);
const oldNeeds = ['a graph of high-leverage PRs merged over time', 'a graph of autonomy over time'];
const pieces = [
  { need: 'merged PRs per hour by repo', path: 'src/web-ui/routes/verse/fleet-metrics/MetricsPane.tsx', exportName: 'MetricsPane' },
  { need: 'merged PRs per launch by hour (human actions are not recorded)', path: 'src/web-ui/routes/verse/fleet-metrics/MetricsPane.tsx', exportName: 'MetricsPane' },
  { need: 'the shared hourly metrics series', path: 'src/core/fleet/metrics-series.ts', exportName: 'readMetricsSeries' },
];
const original = MASON_ASKS.find(ask => ask.id === 'A3');
if (!original || oldNeeds.some(need => original.pieces.filter(piece => piece.need === need && !piece.path).length !== 1)) {
  throw new Error('A3 differs from reviewed PR #6538; inspect before updating. Nothing written.');
}
const updated = { ...original, pieces: [...original.pieces.filter(piece => !oldNeeds.includes(piece.need)), ...pieces] };
const asks = MASON_ASKS.map(ask => ask.id === 'A3' ? updated : ask);
const report = checkMasonAsks(asks, readSourceIndex(fileURLToPath(root), asks));
if (report.asks.find(ask => ask.id === 'A3')?.state !== 'done') {
  throw new Error('A3 implementation evidence is incomplete; nothing written.');
}

const start = source.indexOf("    id: 'A3',");
const end = source.indexOf("    id: 'A4',", start);
if (start < 0 || end < 0) throw new Error('Unrecognized asks source layout; nothing written.');
let section = source.slice(start, end);
const replaceOnce = (from, to) => {
  if (section.split(from).length !== 2) throw new Error('A3 source changed; nothing written.');
  section = section.replace(from, to);
};
const literal = piece => `      { need: '${piece.need}', path: '${piece.path}', exportName: '${piece.exportName}' },`;
replaceOnce(`      { need: '${oldNeeds[0]}' },`, literal(pieces[0]));
replaceOnce(`      { need: '${oldNeeds[1]}' },`, pieces.slice(1).map(literal).join('\n'));
const markdown = renderMasonAsksMarkdown(report, asks);
await writeFile(data, source.slice(0, start) + section + source.slice(end));
await writeFile(doc, markdown);
console.log('Updated A3 evidence and regenerated docs/MASON-ASKS-STATUS.md.');
