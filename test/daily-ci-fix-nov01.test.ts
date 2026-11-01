/**
 * Regression coverage for RQ-PHX-DAILYCIFIX01 — the Nov 1 daily-CI repair
 * order (see BRIDGE_NOTES.md). The Oct 31 scheduled run (41212910266) failed
 * the publication-contracts step and the Mac/Windows Build steps; these tests
 * pin the source-side fixes so none can silently return. All checks are
 * hermetic: they read repository sources only — no network, no gh, no HOME.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TOP_LEVEL_COMMANDS } from '../src/cli/completions.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { hasComputedImportCandidate, runtimeSourceFiles } from './helpers/sidecar-ast-gate.js';

const ROOT = join(__dirname, '..');
const CLI_DIR = join(ROOT, 'src', 'cli');
const fleetSource = readFileSync(join(CLI_DIR, 'fleet.ts'), 'utf8');
const fleetAst = ts.createSourceFile('fleet.ts', fleetSource, ts.ScriptTarget.ES2022, true);

/** Keys of the `FLEET_VERB_OPTIONS` literal plus the reserved-verb array. */
function fleetDispatchShape(): { optionVerbs: Set<string>; reservedVerbs: Set<string> } {
  const optionVerbs = new Set<string>();
  const reservedVerbs = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'FLEET_VERB_OPTIONS'
      && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const prop of node.initializer.properties) {
        const name = ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop)
          ? prop.name : undefined;
        if (name && (ts.isStringLiteral(name) || ts.isIdentifier(name))) optionVerbs.add(name.text);
      }
    }
    // The convention guard's `[...].includes(sub)` list of verbs that own
    // their dispatch path and must not be resolved by convention.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'includes'
      && ts.isArrayLiteralExpression(node.expression.expression)
      && node.arguments.length === 1 && ts.isIdentifier(node.arguments[0]!) && node.arguments[0]!.text === 'sub') {
      for (const el of node.expression.expression.elements) {
        if (ts.isStringLiteral(el)) reservedVerbs.add(el.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fleetAst);
  return { optionVerbs, reservedVerbs };
}

describe('RQ-PHX-DAILYCIFIX01 daily-CI regressions', () => {
  it('fleet convention verbs dispatch through literal loaders only', () => {
    // Modules shipped as src/cli/fleet-<name>.ts whose name is not in
    // FLEET_VERB_OPTIONS and not reserved must be reachable through
    // FLEET_SUBCOMMAND_LOADERS — a computed import(resolved.module) is dead in
    // the compiled sidecar (sidecar-literal-imports-315).
    const { optionVerbs, reservedVerbs } = fleetDispatchShape();
    const conventionNames = new Set(
      readdirSync(CLI_DIR)
        .map(file => /^fleet-([a-z0-9-]+)\.ts$/.exec(file)?.[1])
        .filter((name): name is string => Boolean(name))
        .filter(name => resolveFleetSubcommand(name) !== null)
        .filter(name => !optionVerbs.has(name) && !reservedVerbs.has(name))
        // fleet-subcommand-*.ts are dispatch helpers, not convention modules:
        // the file must actually export the computed command name.
        .filter(name => new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${resolveFleetSubcommand(name)!.exportName}\\b`)
          .test(readFileSync(join(CLI_DIR, `fleet-${name}.ts`), 'utf8'))),
    );
    const registryKeys = new Set(Object.keys(FLEET_SUBCOMMAND_LOADERS));
    expect([...registryKeys].sort(), 'registry must cover exactly the convention-dispatchable fleet modules').toEqual([...conventionNames].sort());
    const registrySource = readFileSync(join(CLI_DIR, 'fleet-subcommand-registry.ts'), 'utf8');
    for (const name of registryKeys) {
      expect(typeof FLEET_SUBCOMMAND_LOADERS[name]).toBe('function');
      expect(registrySource, `loader for ${name} must use a literal specifier`).toContain(`import('./fleet-${name}.js')`);
    }
  });

  it('the sidecar scan gate keeps the AST pass bounded and trivia-proof', { timeout: 30_000 }, () => {
    // The Oct 31 run's publication-contract step died on this scan's 30 s
    // budget, not on an offender. hasComputedImportCandidate is the gate that
    // keeps it fast — a computed specifier can only hide if the gate itself is
    // fooled, so pin its edge cases plus the repo-wide flagged set size.
    expect(hasComputedImportCandidate('const x = await import(specifier);')).toBe(true);
    expect(hasComputedImportCandidate('const x = await import /*c*/ (specifier);')).toBe(true);
    expect(hasComputedImportCandidate('const x = await import(\n\tresolved.module\n);')).toBe(true);
    expect(hasComputedImportCandidate('const x = await import(`./${name}.js`);')).toBe(true);
    expect(hasComputedImportCandidate('const x = await import();')).toBe(true);
    expect(hasComputedImportCandidate("const x = await import('a' + b);")).toBe(true);
    expect(hasComputedImportCandidate('const x = await import("./a.js");')).toBe(false);
    expect(hasComputedImportCandidate("type T = import('./a.js').T;")).toBe(false);
    expect(hasComputedImportCandidate("const p = import('./a.js').then(r => r);")).toBe(false);
    expect(hasComputedImportCandidate('const s = `await import(${JSON.stringify(x)});`;')).toBe(true);
    expect(hasComputedImportCandidate('const s = `txt ${ await import(x) } txt`;')).toBe(true);
    const flagged = [...runtimeSourceFiles(join(ROOT, 'src', 'core')), ...runtimeSourceFiles(join(ROOT, 'src', 'cli'))]
      .filter(file => hasComputedImportCandidate(readFileSync(file, 'utf8')));
    expect(flagged.length, 'AST pass must stay on a handful of files').toBeLessThanOrEqual(60);
  });

  it('top is dispatched by the CLI and offered by completions', () => {
    // cli-registry-drift failed the step: index.ts added `case 'top':` while
    // TOP_LEVEL_COMMANDS never learned it.
    const indexSource = readFileSync(join(CLI_DIR, 'index.ts'), 'utf8');
    expect(indexSource).toContain("case 'top':");
    expect(TOP_LEVEL_COMMANDS).toContain('top');
  });

  it('fleet lane-models is in the verb options and actually dispatches', () => {
    // lane-models sat in FLEET_VERB_OPTIONS — which skips convention dispatch —
    // with no switch case, so the verb fell through to 'unknown subcommand'.
    const { optionVerbs } = fleetDispatchShape();
    expect(optionVerbs.has('lane-models')).toBe(true);
    expect(fleetSource).toContain("case 'lane-models':");
    const moduleText = readFileSync(join(CLI_DIR, 'fleet-lane-models.ts'), 'utf8');
    expect(moduleText).toContain('export async function cmdFleetLaneModels');
  });

  it('no TypeScript build-info artifacts are checked in under src/web-ui', () => {
    // src/web-ui/tsconfig.minimal.tsbuildinfo was committed accidentally by a
    // bridge PR; incremental state belongs under node_modules/.cache.
    const stale = readdirSync(join(ROOT, 'src', 'web-ui')).filter(name => name.endsWith('.tsbuildinfo'));
    expect(stale).toEqual([]);
  });
});
