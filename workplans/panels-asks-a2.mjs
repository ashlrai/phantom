// After PR #6538 lands: node --import tsx workplans/panels-asks-a2.mjs
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
catch { throw new Error('A2 update requires merged PR #6538; nothing written.'); }

const source = await readFile(data, 'utf8');
const { MASON_ASKS } = await import(data.href);
const { checkMasonAsks, readSourceIndex, renderMasonAsksMarkdown } = await import(checker.href);
const pane = 'src/web-ui/routes/verse/fleet-installed/InstalledPane.tsx';
const reader = 'src/core/fleet/installed-panels.ts';
const replacements = {
  'a plugins panel': [
    { need: 'a plugins panel', path: pane, exportName: 'PluginsPane' },
    { need: 'the plugins list agents read (phm plugins list --all --json)', path: reader, exportName: 'readPluginsPanel' },
  ],
  'a skills panel': [
    { need: 'a skills panel', path: pane, exportName: 'SkillsPane' },
    { need: 'the skills list agents read (phm skills list --all --json)', path: reader, exportName: 'readSkillsPanel' },
  ],
};
const original = MASON_ASKS.find(ask => ask.id === 'A2');
if (!original || Object.keys(replacements).some(need => original.pieces.filter(piece => piece.need === need && !piece.path).length !== 1)) {
  throw new Error('A2 differs from reviewed PR #6538; inspect before updating. Nothing written.');
}
const updated = { ...original, pieces: original.pieces.flatMap(piece => replacements[piece.need] ?? [piece]) };
const asks = MASON_ASKS.map(ask => ask.id === 'A2' ? updated : ask);
const report = checkMasonAsks(asks, readSourceIndex(fileURLToPath(root), asks));
if (report.asks.find(ask => ask.id === 'A2')?.state !== 'done') {
  throw new Error('A2 implementation evidence is incomplete; nothing written.');
}

const start = source.indexOf("    id: 'A2',");
const end = source.indexOf("    id: 'A3',", start);
if (start < 0 || end < 0) throw new Error('Unrecognized asks source layout; nothing written.');
let section = source.slice(start, end);
const literal = piece => `      { need: '${piece.need}', path: '${piece.path}', exportName: '${piece.exportName}' },`;
for (const [need, pieces] of Object.entries(replacements)) {
  const from = `      { need: '${need}' },`;
  if (section.split(from).length !== 2) throw new Error('A2 source changed; nothing written.');
  section = section.replace(from, pieces.map(literal).join('\n'));
}
const markdown = renderMasonAsksMarkdown(report, asks);
await writeFile(data, source.slice(0, start) + section + source.slice(end));
await writeFile(doc, markdown);
console.log('Updated A2 evidence and regenerated docs/MASON-ASKS-STATUS.md.');
