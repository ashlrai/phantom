#!/usr/bin/env node
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { add, inventory, extractSource, extractSchema, extractHelp, references, KINDS } from './docs-drift/extract.mjs';
import { publishFix } from './docs-drift/publish.mjs';

export const PHANTOM_PROFILE = {
  sourceRoots: ['src', 'scripts'], dispatch: 'src/cli/index.ts', schema: 'schema/config.schema.json',
  binaries: ['phm', 'ashlr'], envPrefixes: ['ASHLR_', 'PHANTOM_'], toolPrefixes: ['ashlr_', 'phm_'],
  historicalPrefixes: ['docs/internal/'], helpSnapshots: [],
  envSources: ['test/authority-tier1-closure-310b.test.ts'],
  external: { tool: ['ashlr__'], env: ['ASHLR_ALLOW_PROJECT_PATHS', 'ASHLR_SESSION_LOG'] },
};
const MAX_BYTES = 2 * 1024 * 1024;

function read(root, file) {
  const absolute = resolve(root, file);
  const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path outside repository');
  let current = root;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink refused: ${file}`);
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error(`Invalid or oversized input: ${file}`);
  return readFileSync(absolute, 'utf8');
}

function walk(root, directory, accept) {
  const result = [];
  function visit(dir) {
    const absolute = resolve(root, dir);
    const rel = relative(root, absolute);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path outside repository');
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`Symlink refused: ${dir}`);
    for (const item of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', '.git', 'dist', '.github'].includes(item.name)) continue;
      const path = dir ? `${dir}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new Error(`Symlink refused: ${path}`);
      if (item.isDirectory()) visit(path);
      else if (item.isFile() && accept(path)) result.push(path);
    }
  }
  visit(directory);
  return result;
}

export function checkDocsDrift({ root = process.cwd(), profile = PHANTOM_PROFILE } = {}) {
  root = realpathSync(root);
  const facts = inventory();
  const pkg = JSON.parse(read(root, 'package.json'));
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(pkg.version)) throw new Error('Invalid package version');
  add(facts, 'version', pkg.version, 'package.json');
  const sources = [...new Set(profile.sourceRoots.flatMap(dir => walk(root, dir, path => /\.[cm]?[jt]sx?$/.test(path) && !/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(path))))].sort();
  const versions = [];
  for (const file of sources) {
    const text = read(root, file);
    versions.push(...extractSource(text, file, facts, { dispatch: file === profile.dispatch }));
  }
  if (profile.dispatch && !sources.includes(profile.dispatch)) throw new Error('Dispatch source not scanned');
  for (const file of profile.helpSnapshots) extractHelp(read(root, file), file, facts);
  for (const file of profile.envSources ?? []) {
    const support = inventory();
    extractSource(read(root, file), file, support);
    for (const [name, evidence] of support.env) add(facts, 'env', name, evidence.file, evidence.line);
  }
  const openKeys = extractSchema(JSON.parse(read(root, profile.schema)), profile.schema, facts);
  for (const kind of KINDS) if (!facts[kind].size) throw new Error(`Empty ${kind} inventory; review extraction profile`);
  const docs = readdirSync(root).filter(name => /^(?:README(?:\.[\w-]+)?\.md|AGENTS\.md|CLAUDE\.md|llms[^/]*\.txt)$/.test(name));
  docs.push(...walk(root, 'docs', path => /\.(md|txt)$/.test(path)));
  const docProfile = { ...profile, configRoots: [...facts.config.keys()].filter(key => !key.includes('.')) };
  const claims = [...new Set(docs)].sort().flatMap(file => references(read(root, file), file, docProfile));
  claims.push(...versions);
  const mismatches = [], review = [];
  let verified = 0;
  const seen = new Set();
  for (const ref of claims) {
    const id = `${ref.file}:${ref.line}:${ref.column ?? 0}:${ref.kind}:${ref.value}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (facts[ref.kind].has(ref.value)) { verified++; continue; }
    const { historical, ...finding } = ref;
    if (historical) { review.push({ ...finding, reason: 'historical-reference' }); continue; }
    if (ref.context || (profile.external?.[ref.kind] ?? []).some(prefix => ref.value.startsWith(prefix))) {
      review.push({ ...finding, reason: ref.context ?? 'external-companion' }); continue;
    }
    if (ref.kind === 'config' && [...openKeys].some(key => key === '' || ref.value.startsWith(`${key}.`))) {
      review.push({ ...finding, reason: 'open-schema-map' }); continue;
    }
    mismatches.push({ ...finding, expected: ref.kind === 'version' ? pkg.version : null,
      reason: ref.kind === 'version' ? 'stale-version' : 'not-in-source-inventory' });
  }
  return {
    schemaVersion: 1, ok: mismatches.length === 0, version: pkg.version,
    coverage: { sourceFiles: sources.length, documents: docs.length, verifiedReferences: verified,
      reviewReferences: review.length, flagScope: 'repository', helpSnapshots: profile.helpSnapshots,
      inventory: Object.fromEntries(KINDS.map(kind => [kind, facts[kind].size])) },
    mismatches, review,
    inventory: Object.fromEntries(KINDS.map(kind => [kind, [...facts[kind]].sort(([a], [b]) => a.localeCompare(b)).map(([value, evidence]) => ({ value, ...evidence }))])),
  };
}

export function fixPlan(root, report) {
  // No guessed command renames, no broad replacement, no protected code edits.
  // Only the existing current-source version sentence is mechanically provable.
  const changes = new Map();
  const resolved = new Set();
  for (const finding of report.mismatches) {
    if (!finding.fixable || !['README.md', 'docs/QUICKSTART.md'].includes(finding.file)) continue;
    const original = changes.get(finding.file)?.before ?? read(root, finding.file);
    const needle = `This source tree targets version ${finding.value};`;
    // Resolve the exact original occurrence, including duplicates already fixed
    // by an earlier replacement. A malformed sibling claim must stay unresolved.
    if (!original.split(/\r?\n/)[finding.line - 1]?.slice((finding.column ?? 1) - 1).startsWith(needle)) continue;
    const before = changes.get(finding.file)?.after ?? original;
    const after = before.replaceAll(needle, `This source tree targets version ${report.version};`);
    if (after !== before) {
      changes.set(finding.file, { file: finding.file, before: original, after });
    }
    resolved.add(finding);
  }
  const edits = [...changes.values()];
  return { schemaVersion: 1, branch: `docs-drift/${createHash('sha256').update(JSON.stringify(edits)).digest('hex').slice(0, 12)}`,
    changes: edits, unresolved: report.mismatches.filter(f => !resolved.has(f)) };
}

export function main(args) {
  let root = process.cwd(), profileFile, fix = false, planFile, dryRun = false, publisher, job, runsDir;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root' && args[i + 1]) root = resolve(args[++i]);
    else if (arg === '--profile' && args[i + 1]) profileFile = args[++i];
    else if (arg === '--fix') fix = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--plan' && args[i + 1]) planFile = resolve(args[++i]);
    else if (arg === '--publisher' && args[i + 1]) publisher = args[++i];
    else if (arg === '--job' && args[i + 1]) job = args[++i];
    else if (arg === '--runs-dir' && args[i + 1]) runsDir = args[++i];
    else if (arg === '--event' && ['merge', 'nightly', 'manual'].includes(args[i + 1])) i++;
    else if (arg === '--help') {
      console.log('node scripts/check-docs-drift.mjs [--root PATH] [--profile FILE] [--fix [--dry-run] [--plan FILE] [--publisher /path/publish.sh --job JOB --runs-dir /path/runs]]\nJSON: exit 0 clean/completed, 1 drift, 2 invalid input or unavailable publisher.');
      return 0;
    } else throw new Error('Unknown or incomplete argument');
  }
  if (!fix && (dryRun || planFile || publisher || job || runsDir)) throw new Error('Fix options require --fix');
  const profile = profileFile ? JSON.parse(read(realpathSync(root), profileFile)) : PHANTOM_PROFILE;
  const report = checkDocsDrift({ root, profile });
  if (planFile && !dryRun) throw new Error('--plan requires --dry-run');
  if (fix && report.mismatches.length) {
    const plan = fixPlan(root, report);
    const summary = { branchHint: plan.branch, plannedFiles: plan.changes.map(c => c.file), unresolved: plan.unresolved.length };
    if (planFile) writeFileSync(planFile, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (dryRun) report.fix = { status: 'dry-run', ...summary };
    else {
      try { report.fix = publishFix({ root, plan, publisher, job, runsDir }); }
      catch { report.fix = { status: 'refused', ...summary }; }
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.fix?.status === 'publisher-completed') return 0;
  return report.fix && report.fix.status !== 'dry-run' ? 2 : report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch { console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: 'Invalid or unreadable docs-drift input; no application code was executed.' })); process.exitCode = 2; }
}
