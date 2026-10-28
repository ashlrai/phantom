#!/usr/bin/env node
// A local, proposal-only inventory. TypeScript is supplied by the checkout.
import ts from 'typescript';
import { constants, lstatSync, fstatSync, ftruncateSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ignored = new Set(['.git', '.github', 'node_modules', 'dist', 'dist-bin', 'coverage', 'reports', '.ashlr', '.ashlr-gate', '.cache', '.venv']);
const codeExtension = /\.[cm]?[jt]sx?$/;
const textExtension = /\.(?:[cm]?[jt]sx?|md|txt)$/;
const ruleNames = new Set(['ENGINEER-RULES.md', 'agent-rules.txt', 'router-queue.md']);

function filesUnder(root) {
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !ignored.has(entry.name) && !(entry.name === 'worktrees' && dir.endsWith(`${sep}.claude`))) visit(join(dir, entry.name));
      else if (entry.isFile() && textExtension.test(entry.name)) files.push(join(dir, entry.name));
    }
  }
  visit(root);
  return files.sort();
}

function recentChanges(root, now) {
  const result = spawnSync('git', ['log', `--since=${new Date(now.getTime() - 90 * 86400000).toISOString()}`, '--format=%aI', '--name-only', '--no-renames'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.status !== 0) return null;
  const dates = new Map();
  let date = '';
  for (const line of result.stdout.split('\n')) {
    if (/^\d{4}-\d\d-\d\dT/.test(line)) date = line.slice(0, 10);
    else if (line && date && !dates.has(line)) dates.set(line, date);
  }
  const cutoff = now.getTime() - 90 * 86400000;
  for (const [path, value] of dates) if (Date.parse(value) < cutoff) dates.delete(path);
  return dates;
}

function safeText(value) {
  return value.replaceAll('|', '\\|').replace(/[\r\n`]/g, ' ').slice(0, 180);
}

export function buildSweep(root, now = new Date()) {
  root = resolve(root);
  const paths = filesUnder(root);
  const sources = paths.map((path) => ({ path, rel: relative(root, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }));
  const names = new Map();
  const declarations = [];
  for (const source of sources.filter((item) => codeExtension.test(item.rel) && !item.rel.endsWith('.d.ts'))) {
    const ast = ts.createSourceFile(source.rel, source.text, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(source.rel) ? ts.ScriptKind.TSX : undefined);
    function visit(node) {
      if (ts.isIdentifier(node)) names.set(node.text, (names.get(node.text) ?? 0) + 1);
      const exported = !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      const functionDecl = ts.isFunctionDeclaration(node) && node.name && node.body;
      const declaration = (functionDecl || (exported && (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)))) && node.name;
      if (declaration && ts.isIdentifier(node.name)) declarations.push({ name: node.name.text, kind: exported ? 'export' : 'routine', path: source.rel, line: ast.getLineAndCharacterOfPosition(node.name.getStart(ast)).line + 1 });
      if (exported && ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) if (ts.isIdentifier(decl.name)) declarations.push({ name: decl.name.text, kind: 'export', path: source.rel, line: ast.getLineAndCharacterOfPosition(decl.name.getStart(ast)).line + 1 });
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  const changes = recentChanges(root, now);
  const items = declarations.map((decl) => {
    // Count identifiers, not resolved symbols. Name collisions and declarations
    // conservatively suppress suggestions; dynamic and external use is unknown.
    const references = Math.max(0, (names.get(decl.name) ?? 0) - 1);
    const changed = changes === null ? 'unknown' : changes.has(decl.path) ? changes.get(decl.path) : 'none in 90d';
    return { ...decl, use: `${references} identifier references`, outcome: 'unknown', changed, score: Math.min(75, (references ? 50 : 0) + (changed !== 'unknown' && changed !== 'none in 90d' ? 25 : 0)), proposal: references === 0 };
  });
  for (const source of sources.filter((item) => ruleNames.has(item.rel.split('/').at(-1)))) {
    const router = source.rel.endsWith('router-queue.md');
    const plainRules = source.rel.endsWith('agent-rules.txt');
    const lines = source.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!(router ? /^#{1,6}\s+\S/.test(line) : plainRules ? !!line && !line.startsWith('#') : /^(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+)\S/.test(line))) continue;
      const lastUsed = line.match(/\blast-used:\s*(\d{4}-\d{2}-\d{2})\b/i)?.[1];
      const outcome = line.match(/\boutcome:\s*(success|failure|unknown)\b/i)?.[1]?.toLowerCase() ?? 'unknown';
      const timestamp = lastUsed ? Date.parse(`${lastUsed}T00:00:00Z`) : NaN;
      const validDate = Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === lastUsed;
      const age = validDate ? Math.floor((now.getTime() - timestamp) / 86400000) : null;
      const recent = age !== null && age >= 0 && age <= 90;
      const stale = age !== null && age > 90;
      const changed = changes === null ? 'unknown' : changes.get(source.rel) ?? 'none in 90d';
      items.push({ name: line, kind: router ? 'prompt' : 'rule', path: source.rel, line: i + 1, use: age === null || age < 0 ? 'unknown' : `last used ${lastUsed}`, outcome, changed, score: (recent ? 50 : 0) + (outcome === 'success' ? 25 : 0) + (changed !== 'unknown' && changed !== 'none in 90d' ? 25 : 0), proposal: stale && outcome !== 'success' });
    }
  }
  items.sort((a, b) => Number(b.proposal) - Number(a.proposal) || a.score - b.score || a.path.localeCompare(b.path) || a.line - b.line);
  return { generated: now.toISOString(), gitAvailable: changes !== null, items };
}

export function renderSweep(report) {
  const rows = report.items.map((item) => `| ${item.proposal ? 'Review removal' : 'Keep / investigate'} | ${item.kind} | ${safeText(item.path)}:${item.line} | ${safeText(item.name)} | ${item.score}/100 | ${safeText(item.use)} | ${item.outcome} | ${item.changed} |`);
  return [
    '# Weekly deletion sweep', '', `Generated: ${report.generated}`, '',
    'Proposals are for human review only. No files or rules are deleted. External API consumers, dynamic references, runtime activity and outcomes are not observable here; absence of evidence is not evidence of safety.', '',
    'Score: 50 points for a static identifier reference or a rule used in the last 90 days, 25 for an explicitly recorded successful rule outcome, and 25 for a file changed in the last 90 days. Git changes are a maintenance proxy, not usage. Unknown evidence earns no points. An unreferenced declaration or a rule with an explicit last-used date over 90 days ago and no success outcome is proposed for review regardless of score.', '',
    'Rule and prompt evidence can be recorded on the item line as `last-used: YYYY-MM-DD` and `outcome: success|failure|unknown`. Without a valid date, staleness is unknown. Router queue headings are treated as prompts. Engineer rules contribute headings and list items; agent-rules.txt contributes nonempty non-comment lines.', '',
    'Static analysis scans local JS and TS identifiers, named exported declarations and named function routines; name collisions can hide unused code. It does not resolve imports, public APIs, re-exports, default exports, generated files, or runtime calls. Review callers and policy before any change.', '',
    `Git history: ${report.gitAvailable ? 'available (last 90 days)' : 'unavailable; file activity unknown'}.`, '',
    '| Proposal | Kind | Location | Item | Score | Recent use evidence | Outcome | File activity |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows, '',
  ].join('\n');
}

export function writeSweep(root, report) {
  const dir = join(resolve(root), 'reports');
  try { mkdirSync(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('reports must be a real directory');
  const target = join(dir, 'deletion-sweep.md');
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('report must be a regular file with one link');
    writeFileSync(fd, renderSweep(report));
    // Writing through an existing descriptor does not truncate longer prior reports.
    // Explicit truncation is restricted to this report file.
    ftruncateSync(fd, Buffer.byteLength(renderSweep(report)));
  } finally { closeSync(fd); }
  return target;
}

function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node scripts/must-earn-its-place.mjs [--repo <directory>]');
    return 0;
  }
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--repo' && args[1] && !args[1].startsWith('-'))) {
    console.error('Usage: node scripts/must-earn-its-place.mjs [--repo <directory>]');
    return 2;
  }
  try {
    const root = resolve(args[1] ?? process.cwd());
    const report = buildSweep(root);
    const target = writeSweep(root, report);
    console.log(`Wrote ${target} (${report.items.filter((item) => item.proposal).length} proposals; ${report.items.length} items scored).`);
    return 0;
  } catch (error) {
    console.error(`Sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
