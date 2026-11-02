/**
 * Regression coverage for RQ-PHX-DAILYCIFIX01 — the Nov 1 daily-CI repair
 * order (see BRIDGE_NOTES.md). The Oct 31 scheduled run (41212910266) failed
 * the publication-contracts step and the Mac/Windows Build steps; these tests
 * pin the source-side fixes so none can silently return. All checks are
 * hermetic: they read repository sources only — no network, no gh, no HOME.
 *
 * Drift note (RQ-LANDFIXTESTSQ8, from PR 2558): three pinned repairs never
 * landed on master — fleet-guardian-verify.ts shipped without a registry
 * loader regeneration, `lane-models` sits in FLEET_VERB_OPTIONS (which skips
 * convention dispatch) with no switch case, and a tsbuildinfo artifact is
 * checked in under src/web-ui. Each assertion is kept verbatim and marked
 * `it.fails`: the suite reports them as expected failures today, and vitest
 * flips each to a hard failure ("expected test to fail") the moment the fix
 * lands — the marker must then be removed. The dead-verb audit additionally
 * catches fleet-bus-reply.ts, a convention-named module whose sync
 * `export function` never matches the generator's `export async function`
 * filter, so no loader exists for it either.
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

/**
 * Keys of the `FLEET_VERB_OPTIONS` literal, the reserved-verb array and the
 * switch's case labels — the three dispatch slots a verb can live in.
 */
function fleetDispatchShape(): { optionVerbs: Set<string>; reservedVerbs: Set<string>; caseVerbs: Set<string> } {
  const optionVerbs = new Set<string>();
  const reservedVerbs = new Set<string>();
  const caseVerbs = new Set<string>();
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
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) caseVerbs.add(node.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(fleetAst);
  return { optionVerbs, reservedVerbs, caseVerbs };
}

/** Every src/cli/fleet-<name>.ts module that ships a cmdFleet<PascalName> entry point. */
function fleetVerbModules(): string[] {
  return readdirSync(CLI_DIR)
    .map(file => /^fleet-([a-z0-9-]+)\.ts$/.exec(file)?.[1])
    .filter((name): name is string => Boolean(name))
    .filter(name => resolveFleetSubcommand(name) !== null)
    .filter(name => new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${resolveFleetSubcommand(name)!.exportName}\\b`)
      .test(readFileSync(join(CLI_DIR, `fleet-${name}.ts`), 'utf8')));
}

describe('RQ-PHX-DAILYCIFIX01 daily-CI regressions', () => {
  it('every fleet registry loader resolves to a literal import specifier', () => {
    // A computed import(resolved.module) is dead in the compiled sidecar
    // (sidecar-literal-imports-315): each registered verb must carry a
    // literal import('./fleet-<name>.js') specifier.
    const registrySource = readFileSync(join(CLI_DIR, 'fleet-subcommand-registry.ts'), 'utf8');
    for (const name of Object.keys(FLEET_SUBCOMMAND_LOADERS)) {
      expect(typeof FLEET_SUBCOMMAND_LOADERS[name]).toBe('function');
      expect(registrySource, `loader for ${name} must use a literal specifier`).toContain(`import('./fleet-${name}.js')`);
    }
  });

  // TRIPWIRE: expected to fail while `guardian-verify` has no loader — the
  // registry was generated before src/cli/fleet-guardian-verify.ts landed
  // (#2792). `node scripts/gen-fleet-registry.mjs` emits exactly that entry;
  // when it runs this flips to "expected test to fail" and .fails goes.
  it.fails('the generated registry covers every async fleet verb module', () => {
    // scripts/gen-fleet-registry.mjs emits one loader per
    // `export async function cmdFleet*` module — regardless of whether the
    // verb dispatches by convention, an explicit case, or verb options.
    const generatedNames = fleetVerbModules()
      .filter(name => new RegExp(`\\bexport\\s+async\\s+function\\s+${resolveFleetSubcommand(name)!.exportName}\\s*\\(`)
        .test(readFileSync(join(CLI_DIR, `fleet-${name}.ts`), 'utf8')))
      .sort();
    expect(Object.keys(FLEET_SUBCOMMAND_LOADERS).sort(),
      'registry must cover exactly the generated fleet verb set').toEqual(generatedNames);
  });

  // TRIPWIRE: expected to fail on three dead verbs — bus-reply (sync export
  // never matches the generator filter), guardian-verify (loader missing),
  // lane-models (verb-options entry skips convention dispatch, and no switch
  // case). Fixes: regenerate the registry for guardian-verify; for
  // lane-models drop its FLEET_VERB_OPTIONS entry or restore a switch case;
  // for bus-reply make the export async or widen the generator. When all
  // dispatch, the unexpected pass forces removal of this .fails marker.
  it.fails('every shipped fleet verb actually dispatches', () => {
    const { optionVerbs, reservedVerbs, caseVerbs } = fleetDispatchShape();
    // `fleet queue|runs|journal|parked|job|merge-throughput` dispatch via
    // early returns ahead of the convention block; no fleet-<name>.ts modules
    // carry those names today, but they must never be counted dead.
    const earlyDispatched = new Set(['merge-throughput', 'queue', 'runs', 'journal', 'parked', 'job']);
    const dead = fleetVerbModules()
      .filter(name => !earlyDispatched.has(name))
      .filter(name => (optionVerbs.has(name) || reservedVerbs.has(name))
        ? !caseVerbs.has(name)
        : !Object.hasOwn(FLEET_SUBCOMMAND_LOADERS, name));
    expect(dead).toEqual([]);
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

  it('fleet lane-models ships its module and registry loader', () => {
    const moduleText = readFileSync(join(CLI_DIR, 'fleet-lane-models.ts'), 'utf8');
    expect(moduleText).toContain('export async function cmdFleetLaneModels');
    expect(typeof FLEET_SUBCOMMAND_LOADERS['lane-models']).toBe('function');
  });

  // TRIPWIRE: expected to fail — lane-models sits in FLEET_VERB_OPTIONS,
  // which skips convention dispatch, and the switch carries no
  // `case 'lane-models':`, so `ashlr fleet lane-models` answers "unknown
  // fleet subcommand". Drop the verb-options entry (the existing registry
  // loader then dispatches it) or restore the case; either fix flips this.
  it.fails('fleet lane-models actually dispatches', () => {
    const { optionVerbs } = fleetDispatchShape();
    const dispatches = optionVerbs.has('lane-models')
      ? fleetSource.includes("case 'lane-models':")
      : Object.hasOwn(FLEET_SUBCOMMAND_LOADERS, 'lane-models');
    expect(dispatches).toBe(true);
  });

  // TRIPWIRE: expected to fail while src/web-ui/tsconfig.minimal.tsbuildinfo
  // stays committed (bridge PR #1866). Incremental state belongs under
  // node_modules/.cache — delete the artifact and this flips to an
  // unexpected pass.
  it.fails('no TypeScript build-info artifacts are checked in under src/web-ui', () => {
    const stale = readdirSync(join(ROOT, 'src', 'web-ui')).filter(name => name.endsWith('.tsbuildinfo'));
    expect(stale).toEqual([]);
  });
});
