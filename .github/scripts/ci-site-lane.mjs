#!/usr/bin/env node
/* global process, console */
// Only a PR modifying these existing, regular ecosystem files can skip the
// exhaustive matrix. Unknown Git state fails the classifier instead of
// producing a site qualification.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const SITE_ONLY_PATHS = Object.freeze([
  'site/ecosystem.html',
  'site/assets/ecosystem.js',
  'site/assets/star-history.js',
  'site/sitemap.xml',
]);
// Reviewed public prose only. Companion/context/prompt, authority, financial,
// release and contract guides have other readers and remain full qualification.
// Package/version changes and every unreviewed path also stay in the full lane.
export const DOCUMENTATION_ONLY_PATHS = Object.freeze([
  'docs/PHANTOM-BRAND.md',
  'docs/DEMO.md',
]);
const documentation = new Set(DOCUMENTATION_ONLY_PATHS);
export const DOCUMENTATION_POLICY_INPUTS = Object.freeze([
  '.github/scripts/ci-site-lane.mjs', '.github/scripts/ci-docs-lane.mjs',
  '.github/tests/ci-site-lane.test.mjs', '.github/tests/ci-docs-lane.test.mjs',
  '.github/tests/hosted-build-artifact.test.mjs', '.github/workflows/ci.yml', 'test/m30.ci.test.ts',
  '.github/scripts/ci-frontend-lane.mjs', '.github/tests/ci-frontend-lane.test.mjs',
]);
// Audited composed 3.29.16 source inputs, not historical test results.
// Sealing the remaining tracked tree also catches new generic/computed readers.
// Changed inputs require explicit reader requalification before another fast PR.
export const DOCUMENTATION_READER_INVENTORY_DIGEST = '435c6eacd90fea68c6a0492c0b1e644551d851c7526fd50d08bdd23cd300958e';

// Exact reviewed presentation paths. This is PR feedback, not an authority policy
// or a general dependency graph; new/control/auth/data/config paths stay full.
export const FRONTEND_ONLY_PATHS = Object.freeze([
  "src/web-ui/components/charts/AreaTrend.tsx",
  "src/web-ui/components/charts/BarChart.module.css",
  "src/web-ui/components/charts/BarChart.tsx",
  "src/web-ui/components/charts/BarStack.tsx",
  "src/web-ui/components/charts/CalendarHeatmap.tsx",
  "src/web-ui/components/charts/ChartContainer.module.css",
  "src/web-ui/components/charts/ChartContainer.tsx",
  "src/web-ui/components/charts/ChartFrame.module.css",
  "src/web-ui/components/charts/ChartFrame.tsx",
  "src/web-ui/components/charts/ChartParts.tsx",
  "src/web-ui/components/charts/ForestPlot.module.css",
  "src/web-ui/components/charts/ForestPlot.tsx",
  "src/web-ui/components/charts/Funnel.tsx",
  "src/web-ui/components/charts/Gauge.module.css",
  "src/web-ui/components/charts/Gauge.tsx",
  "src/web-ui/components/charts/Legend.module.css",
  "src/web-ui/components/charts/Legend.tsx",
  "src/web-ui/components/charts/LineChart.module.css",
  "src/web-ui/components/charts/LineChart.tsx",
  "src/web-ui/components/charts/MatrixHeatmap.module.css",
  "src/web-ui/components/charts/MatrixHeatmap.tsx",
  "src/web-ui/components/charts/Sparkline.module.css",
  "src/web-ui/components/charts/Sparkline.tsx",
  "src/web-ui/components/charts/StatTile.module.css",
  "src/web-ui/components/charts/StatTile.tsx",
  "src/web-ui/components/charts/StepBand.tsx",
  "src/web-ui/components/charts/Swimlane.module.css",
  "src/web-ui/components/charts/Swimlane.tsx",
  "src/web-ui/components/charts/TableView.module.css",
  "src/web-ui/components/charts/TableView.tsx",
  "src/web-ui/components/charts/chart-math.ts",
  "src/web-ui/components/charts/chart-tokens.css",
  "src/web-ui/components/charts/colors.ts",
  "src/web-ui/components/charts/format-metric.ts",
  "src/web-ui/components/charts/format.ts",
  "src/web-ui/components/charts/index.ts",
  "src/web-ui/components/charts/motion.ts",
  "src/web-ui/components/charts/plot.module.css",
  "src/web-ui/components/charts/types.ts",
  "src/web-ui/components/charts/useChartWidth.ts",
  "src/web-ui/components/charts/useTextScale.ts",
  "src/web-ui/components/layout/Shell.module.css",
  "src/web-ui/components/layout/Sidebar.module.css",
  "src/web-ui/components/layout/Topbar.module.css",
  "src/web-ui/components/primitives/Button.module.css",
  "src/web-ui/components/primitives/Button.tsx",
  "src/web-ui/components/primitives/Dialog.module.css",
  "src/web-ui/components/primitives/Dialog.tsx",
  "src/web-ui/components/primitives/EmptyState.module.css",
  "src/web-ui/components/primitives/EmptyState.tsx",
  "src/web-ui/components/primitives/Epistemic.module.css",
  "src/web-ui/components/primitives/Input.module.css",
  "src/web-ui/components/primitives/Input.tsx",
  "src/web-ui/components/primitives/Meter.module.css",
  "src/web-ui/components/primitives/RefreshIndicator.module.css",
  "src/web-ui/components/primitives/RefreshIndicator.tsx",
  "src/web-ui/components/primitives/RouteErrorBoundary.module.css",
  "src/web-ui/components/primitives/RouteErrorBoundary.tsx",
  "src/web-ui/components/primitives/Segmented.module.css",
  "src/web-ui/components/primitives/Segmented.tsx",
  "src/web-ui/components/primitives/Select.module.css",
  "src/web-ui/components/primitives/Select.tsx",
  "src/web-ui/components/primitives/Sheet.module.css",
  "src/web-ui/components/primitives/Sheet.tsx",
  "src/web-ui/components/primitives/Skeleton.module.css",
  "src/web-ui/components/primitives/Skeleton.tsx",
  "src/web-ui/components/primitives/Slider.module.css",
  "src/web-ui/components/primitives/Slider.tsx",
  "src/web-ui/components/primitives/StatusBadge.module.css",
  "src/web-ui/components/primitives/Switch.module.css",
  "src/web-ui/components/primitives/Switch.tsx",
  "src/web-ui/components/primitives/Tag.module.css",
  "src/web-ui/components/primitives/Tag.tsx",
  "src/web-ui/components/primitives/Toast.module.css",
  "src/web-ui/components/primitives/Toast.tsx",
  "src/web-ui/components/primitives/Tooltip.module.css",
  "src/web-ui/components/primitives/Tooltip.tsx",
  "src/web-ui/components/primitives/icon-base.tsx",
  "src/web-ui/components/primitives/icons.tsx",
  "src/web-ui/components/primitives/index.ts",
  "src/web-ui/design/global.css",
  "src/web-ui/design/tokens.css"
]);
export const FRONTEND_POLICY_INPUTS = DOCUMENTATION_POLICY_INPUTS;
export const FRONTEND_READER_INVENTORY_DIGEST = '49cdc49ef15b0d02bf493a9bf2173cdcd1a647f23f4468d6f9b0fb1950c6780c';
export const FRONTEND_IMPORT_INVENTORY_DIGEST = 'a603dae17723f5641f5a12845559571960f9b7148089b0342af14129635dc6f5';
const frontend = new Set(FRONTEND_ONLY_PATHS);
const require = createRequire(import.meta.url);

function frontendImports(path, text) {
  if (path.endsWith('.css')) {
    // Escaped function names cannot be classified from ordinary CSS tokens.
    if (text.includes('\\')) throw new Error('Unknown escaped CSS dependency');
    const css = require('postcss').parse(text); const dependencies = [];
    css.walkAtRules('import', (rule) => dependencies.push(['import', rule.params]));
    css.walkDecls((declaration) => {
      if (/\burl\s*\(/i.test(declaration.value)) dependencies.push(['url', declaration.value]);
    });
    return dependencies.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  }
  const ts = require('typescript'); const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) throw new Error('Invalid frontend source syntax');
  const dependencies = [];
  const visit = (node) => {
    if (ts.isMetaProperty(node)) throw new Error('Unknown frontend metadata import');
    if (ts.isIdentifier(node) && node.text === 'require' && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) throw new Error('Unknown aliased frontend import');
    if (ts.isImportTypeNode(node)) {
      if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteralLike(node.argument.literal)) throw new Error('Unknown frontend type import');
      dependencies.push(['type', node.argument.literal.text]);
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        if (!ts.isStringLiteralLike(node.moduleSpecifier)) throw new Error('Unknown frontend import');
        // Include type imports too: changing even a type reader requires review.
        dependencies.push(['module', node.moduleSpecifier.text]);
      }
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) throw new Error('Computed frontend import');
      dependencies.push(['dynamic', node.arguments[0].text]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return dependencies.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
}
export function frontendImportInventory(cwd, revision) {
  if (!shaPattern.test(revision)) throw new Error('Invalid frontend import revision');
  const tree = git(cwd, ['ls-tree', '-rz', '--full-tree', revision]).toString('utf8');
  if (!tree.endsWith('\0')) throw new Error('Incomplete frontend import tree');
  const blobs = new Map();
  for (const row of tree.slice(0, -1).split('\0')) {
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([^\0]+)$/.exec(row);
    if (!match || blobs.has(match[4])) throw new Error('Unknown frontend import tree entry');
    blobs.set(match[4], { mode: match[1], type: match[2], blob: match[3] });
  }
  const inputs = FRONTEND_ONLY_PATHS.map((path) => {
    const value = blobs.get(path);
    if (!value || value.mode !== '100644' || value.type !== 'blob') throw new Error('Missing regular frontend input');
    return { path, blob: value.blob };
  });
  // One bounded object read replaces hundreds of Git processes per classifier.
  // Object headers, lengths and requested order remain exact and fail closed.
  const bytes = git(cwd, ['cat-file', '--batch'], `${inputs.map((item) => item.blob).join('\n')}\n`);
  let offset = 0;
  const entries = inputs.map(({ path, blob }) => {
    const end = bytes.indexOf(10, offset); if (end < 0) throw new Error('Missing frontend blob header');
    const header = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(bytes.subarray(offset, end).toString());
    if (!header || header[1] !== blob) throw new Error('Unexpected frontend object');
    const size = Number(header[2]); offset = end + 1;
    if (!Number.isSafeInteger(size) || size > 1024 * 1024 || offset + size >= bytes.length || bytes[offset + size] !== 10) throw new Error('Frontend blob exceeds bound');
    const text = bytes.subarray(offset, offset + size).toString('utf8'); offset += size + 1;
    return [path, frontendImports(path, text)];
  });
  if (offset !== bytes.length) throw new Error('Extra frontend objects');
  return { schema: 'phantom-frontend-import-inventory/v1', entries: entries.length,
    digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
export function frontendReaderInventory(cwd, revision) {
  return trackedReaderInventory(cwd, revision, new Set([...FRONTEND_ONLY_PATHS, ...FRONTEND_POLICY_INPUTS]),
    'phantom-frontend-reader-inventory/v1');
}
function candidatePaths({ eventName, cwd, base, head }) {
  if (eventName !== 'pull_request' || !shaPattern.test(base ?? '') || !shaPattern.test(head ?? '')) return [];
  if (git(cwd, ['rev-parse', 'HEAD']).toString().trim() !== head) throw new Error('checkout does not match PR head');
  const mergeBase = git(cwd, ['merge-base', base, head]).toString().trim();
  const output = git(cwd, ['diff', '--name-only', '-z', '--no-renames', mergeBase, head]).toString();
  if (!output || !output.endsWith('\0')) return [];
  const paths = output.slice(0, -1).split('\0');
  return paths.every((path) => frontend.has(path) && regularBlobAt(cwd, mergeBase, path) && regularBlobAt(cwd, head, path)) ? paths : [];
}
export function frontendCandidate(input) { return candidatePaths(input).length > 0; }

const inventoryExclusions = new Set([...DOCUMENTATION_ONLY_PATHS, ...DOCUMENTATION_POLICY_INPUTS]);
const allowed = new Set(SITE_ONLY_PATHS);
const shaPattern = /^[0-9a-f]{40}$/;

function git(cwd, args, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, env, input, maxBuffer: 4 * 1024 * 1024 });
}

function regularBlobAt(cwd, ref, path) {
  const tree = git(cwd, ['ls-tree', '-z', ref, '--', path]).toString('utf8');
  const entry = /^([0-7]{6}) blob [0-9a-f]+\t([^\0]+)\0$/.exec(tree);
  return entry?.[1] === '100644' && entry[2] === path;
}

function trackedReaderInventory(cwd, revision, exclusions, schema) {
  if (!shaPattern.test(revision)) throw new Error('Invalid reader inventory revision');
  const output = git(cwd, ['ls-tree', '-rz', '--full-tree', revision]).toString('utf8');
  if (!output || !output.endsWith('\0')) throw new Error('Incomplete reader inventory');
  const seen = new Set();
  const rows = output.slice(0, -1).split('\0').map((value) => {
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([^\0]+)$/.exec(value);
    if (!match || seen.has(match[4])) throw new Error('Unknown reader inventory entry');
    seen.add(match[4]); return [match[4], match[1], match[2], match[3]];
  }).filter(([path]) => !exclusions.has(path));
  if (!rows.length || rows.length > 100_000) throw new Error('Reader inventory outside its bound');
  rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return { schema, entries: rows.length,
    digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
}

export function documentationReaderInventory(cwd, revision) {
  return trackedReaderInventory(cwd, revision, inventoryExclusions, 'phantom-documentation-reader-inventory/v1');
}

// The digest injection is a pure fixture seam; the CLI has no flag or environment
// override and always uses the audited source constant above.
export function classifySiteLane({ eventName, base, head, cwd, reviewedReaderDigest = DOCUMENTATION_READER_INVENTORY_DIGEST,
  reviewedFrontendReaderDigest = FRONTEND_READER_INVENTORY_DIGEST, reviewedFrontendImportDigest = FRONTEND_IMPORT_INVENTORY_DIGEST }) {
  // Default-branch pushes and reusable release calls always qualify fully.
  if (eventName !== 'pull_request') return 'full';
  if (!shaPattern.test(base ?? '') || !shaPattern.test(head ?? '')) {
    throw new Error('PR base and head must be exact commit SHAs');
  }
  const checkedOut = git(cwd, ['rev-parse', 'HEAD']).toString('utf8').trim();
  if (checkedOut !== head) throw new Error('checkout does not match PR head');
  const mergeBase = git(cwd, ['merge-base', base, head]).toString('utf8').trim();
  if (!shaPattern.test(mergeBase)) throw new Error('PR merge base is unavailable');
  const changed = git(cwd, [
    'diff', '--name-only', '-z', '--no-renames', mergeBase, head,
  ]).toString('utf8');
  if (!changed) return 'full';
  if (!changed.endsWith('\0')) throw new Error('Git returned an incomplete path list');
  const paths = changed.slice(0, -1).split('\0');
  if (paths.every((path) => documentation.has(path)) && paths.every((path) =>
    regularBlobAt(cwd, mergeBase, path) && regularBlobAt(cwd, head, path))) {
    try {
      if (/^[a-f0-9]{64}$/.test(reviewedReaderDigest) && documentationReaderInventory(cwd, head).digest === reviewedReaderDigest) return 'documentation';
    } catch { /* Unknown or invalid inventory selects full qualification. */ }
    return 'full';
  }
  if (paths.every((path) => frontend.has(path))) {
    try {
      if (!candidatePaths({ eventName, cwd, base, head }).length) return 'full';
      const valid = (digest) => /^[a-f0-9]{64}$/.test(digest);
      if (valid(reviewedFrontendReaderDigest) && valid(reviewedFrontendImportDigest) &&
        frontendReaderInventory(cwd, head).digest === reviewedFrontendReaderDigest &&
        frontendImportInventory(cwd, head).digest === reviewedFrontendImportDigest) return 'frontend';
    } catch { /* Missing parser, computed dependency or unreviewed reader stays full. */ }
    return 'full';
  }
  if (paths.some((path) => !allowed.has(path))) return 'full';
  if (paths.some((path) => !regularBlobAt(cwd, mergeBase, path) ||
      !regularBlobAt(cwd, head, path))) return 'full';
  return 'site';
}

/** A PR-only source plan; it is never a full release qualification receipt. */
export function documentationPlan(input) {
  if (classifySiteLane(input) !== 'documentation') throw new Error('Not a reviewed documentation-only PR');
  const { cwd, base, head } = input;
  if (git(cwd, ['status', '--porcelain', '--untracked-files=normal']).length) throw new Error('Documentation checkout is dirty');
  const mergeBase = git(cwd, ['merge-base', base, head]).toString('utf8').trim();
  const tree = git(cwd, ['rev-parse', `${head}^{tree}`]).toString('utf8').trim();
  const paths = git(cwd, ['diff', '--name-only', '-z', '--no-renames', mergeBase, head])
    .toString('utf8').slice(0, -1).split('\0').sort();
  const blob = (ref, path) => git(cwd, ['rev-parse', `${ref}:${path}`]).toString('utf8').trim();
  if (!shaPattern.test(tree)) throw new Error('Missing documentation tree identity');
  return { schema: 'phantom-documentation-pr-plan/v1', releaseEligible: false,
    base, mergeBase, head, tree,
    policyDigest: createHash('sha256').update(JSON.stringify(DOCUMENTATION_ONLY_PATHS)).digest('hex'),
    readerInventory: documentationReaderInventory(cwd, head),
    policyInputs: DOCUMENTATION_POLICY_INPUTS.map((path) => {
      if (!regularBlobAt(cwd, head, path)) throw new Error('Missing regular documentation policy input');
      return { path, blob: blob(head, path) };
    }),
    changes: paths.map((path) => ({ path, baseBlob: blob(mergeBase, path), headBlob: blob(head, path) })) };
}

/** Fresh exact-source PR feedback only; never a producer receipt. */
export function frontendPlan(input) {
  if (classifySiteLane(input) !== 'frontend') throw new Error('Not a reviewed frontend-only PR');
  const { cwd, base, head } = input;
  if (git(cwd, ['status', '--porcelain', '--untracked-files=normal']).length) throw new Error('Frontend checkout is dirty');
  const mergeBase = git(cwd, ['merge-base', base, head]).toString().trim();
  const tree = git(cwd, ['rev-parse', `${head}^{tree}`]).toString().trim();
  const blob = (ref, path) => git(cwd, ['rev-parse', `${ref}:${path}`]).toString().trim();
  return { schema: 'phantom-frontend-pr-plan/v1', releaseEligible: false, base, mergeBase, head, tree,
    policyDigest: createHash('sha256').update(JSON.stringify(FRONTEND_ONLY_PATHS)).digest('hex'),
    readerInventory: frontendReaderInventory(cwd, head), importInventory: frontendImportInventory(cwd, head),
    policyInputs: FRONTEND_POLICY_INPUTS.map((path) => {
      if (!regularBlobAt(cwd, head, path)) throw new Error('Missing regular frontend policy input');
      return { path, blob: blob(head, path) };
    }), changes: candidatePaths(input).sort().map((path) => ({ path, baseBlob: blob(mergeBase, path), headBlob: blob(head, path) })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === '--frontend-candidate')) throw new Error('Usage: ci-site-lane.mjs [--frontend-candidate]');
    const input = {
      eventName: process.env.GITHUB_EVENT_NAME,
      base: process.env.ASHLR_CI_BASE_SHA,
      head: process.env.ASHLR_CI_HEAD_SHA,
      cwd: process.cwd(),
    };
    if (process.argv[2] === '--frontend-candidate') {
      const value = frontendCandidate(input);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `frontend_candidate=${value}\n`);
      console.log(`Frontend dependency candidate: ${value}`);
    } else {
    const lane = classifySiteLane(input);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'lane=' + lane + '\n');
    console.log('CI lane: ' + lane);
    }
  } catch (error) {
    console.error('CI lane classification failed: ' + error.message);
    process.exitCode = 1;
  }
}
