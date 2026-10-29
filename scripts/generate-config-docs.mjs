#!/usr/bin/env node
/**
 * scripts/generate-config-docs.mjs - regenerate docs/CONFIG-REFERENCE.md from
 * schema/config.schema.json, the source of truth for ~/.ashlr/config.json.
 *
 * docs/CONFIG-REFERENCE.md is generated, not authored: it embeds the schema's
 * own property paths, types, enums, consts, unions, constraints and
 * descriptions so the published config reference can never drift from the
 * validator a user runs. After changing the schema, regenerate:
 *
 *   node scripts/generate-config-docs.mjs           rewrite docs/CONFIG-REFERENCE.md
 *   node scripts/generate-config-docs.mjs --check   exit 1 when the doc is stale
 *
 * Rendering is deterministic: schema property order is preserved, `$ref`
 * targets are expanded inline, `[]` marks array elements, `*` marks
 * additionalProperties map values, `/<regex>/` marks patternProperties keys
 * and `<n>` marks oneOf/anyOf variant positions. The schema declares no
 * defaults; applied defaults live in src/core/config.ts and are out of scope
 * for this table. test/config-docs-drift.test.ts holds the committed file to
 * this output.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DOC_PATH = 'docs/CONFIG-REFERENCE.md';
const SCHEMA_PATH = 'schema/config.schema.json';

/** Escape the pipe that would break a Markdown table cell; flatten whitespace. */
function cell(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

/** Render a literal JSON value for a type cell: `enum`/`const` entries. */
function literal(value) {
  if (value === null) return '`null`';
  if (typeof value === 'string') return `\`'${value}'\``;
  return `\`${JSON.stringify(value)}\``;
}

function describeObject(node, resolveRef) {
  const props = node.properties ? Object.keys(node.properties).length : 0;
  const addl = node.additionalProperties;
  const patterns = node.patternProperties ? Object.keys(node.patternProperties).length : 0;
  const suffixes = [];
  if (props > 0) suffixes.push(`${props} ${props === 1 ? 'key' : 'keys'}`);
  if (addl === true) suffixes.push('open');
  else if (addl && typeof addl === 'object') suffixes.push(`map to ${describeType(addl, resolveRef)}`);
  if (patterns > 0) suffixes.push('patterned');
  if (addl === false) suffixes.push('closed');
  return `\`object\`${suffixes.length > 0 ? ` (${suffixes.join('; ')})` : ''}`;
}

/**
 * Compact type summary for one schema node: the declared `type` (string or
 * type array), `enum`/`const` vocabulary, object/array/combinator shape and
 * the numeric/string constraints the validator enforces.
 */
function describeType(node, resolveRef) {
  const target = node && node.$ref ? resolveRef(node.$ref) : node;
  if (!target || typeof target !== 'object') return '`any`';
  const parts = [];
  const types = Array.isArray(target.type) ? target.type : target.type ? [target.type] : [];
  for (const type of types) {
    if (type === 'object') parts.push(describeObject(target, resolveRef));
    else if (type === 'array') parts.push(`array of ${describeType(target.items ?? {}, resolveRef)}`);
    else parts.push(`\`${type}\``);
  }
  if (target.const !== undefined) parts.push(`const ${literal(target.const)}`);
  if (Array.isArray(target.enum)) parts.push(`enum: ${target.enum.map(literal).join(' \\| ')}`);
  if (Array.isArray(target.oneOf)) parts.push(`one of ${target.oneOf.length}:`);
  if (Array.isArray(target.anyOf)) parts.push(`any of ${target.anyOf.length}:`);
  if (parts.length === 0) {
    if (target.properties || target.additionalProperties || target.patternProperties) {
      parts.push(describeObject(target, resolveRef));
    } else if (target.items) {
      parts.push(`array of ${describeType(target.items, resolveRef)}`);
    } else {
      parts.push('`any`');
    }
  }
  const bounds = [];
  if (typeof target.minimum === 'number') bounds.push(`>= ${target.minimum}`);
  if (typeof target.maximum === 'number') bounds.push(`<= ${target.maximum}`);
  if (typeof target.minLength === 'number' || typeof target.maxLength === 'number') {
    bounds.push(`length ${target.minLength ?? 0}..${target.maxLength ?? 'unbounded'}`);
  }
  if (typeof target.pattern === 'string') bounds.push(`/${target.pattern}/`);
  if (bounds.length > 0) parts.push(`(${bounds.join('; ')})`);
  return parts.join(' ');
}

/** Resolve a local `#/definitions/Name` reference against the schema. */
export function makeResolver(schema) {
  return (ref) => {
    const match = /^#\/definitions\/([A-Za-z0-9_-]+)$/.exec(ref);
    if (!match || !schema.definitions || typeof schema.definitions[match[1]] !== 'object') {
      throw new Error(`unsupported $ref ${ref}`);
    }
    return schema.definitions[match[1]];
  };
}

/**
 * Depth-first row list for one schema subtree. `path` is the dotted key this
 * node occupies; `required` reflects the parent object's `required` list
 * ('yes'/'no'), and '-' where the key cannot be required by position (array
 * elements, map values, union variants). Pass `emit: false` for a section
 * root so the property's own row (already in the top-level table) is not
 * repeated.
 */
export function* schemaRows(node, { path, required = '-', emit = true, resolveRef, seen = new Set() } = {}) {
  const target = node && node.$ref ? resolveRef(node.$ref) : node;
  if (!target || typeof target !== 'object') return;
  if (emit) {
    yield {
      path,
      type: describeType(node, resolveRef),
      required,
      description: typeof target.description === 'string' ? target.description : '',
    };
  }
  // The `seen` guard tracks only ancestor refs: a recursive $ref fails fast
  // instead of hanging, while sibling properties may reuse one definition.
  if (node && node.$ref) {
    if (seen.has(node.$ref)) return;
    seen.add(node.$ref);
  }
  const descend = function* (child, suffix) {
    yield* schemaRows(child, { path: `${path}${suffix}`, required: '-', resolveRef, seen });
  };
  if (target.properties && typeof target.properties === 'object') {
    const requiredKeys = new Set(Array.isArray(target.required) ? target.required : []);
    for (const [key, child] of Object.entries(target.properties)) {
      yield* schemaRows(child, {
        path: `${path}.${key}`,
        required: requiredKeys.has(key) ? 'yes' : 'no',
        resolveRef,
        seen,
      });
    }
  }
  if (target.items && typeof target.items === 'object') yield* descend(target.items, '[]');
  if (target.additionalProperties && typeof target.additionalProperties === 'object') {
    yield* descend(target.additionalProperties, '.*');
  }
  if (target.patternProperties && typeof target.patternProperties === 'object') {
    for (const [pattern, child] of Object.entries(target.patternProperties)) {
      yield* descend(child, `/${pattern}/`);
    }
  }
  for (const combinator of ['oneOf', 'anyOf']) {
    if (Array.isArray(target[combinator])) {
      for (const [index, variant] of target[combinator].entries()) {
        yield* descend(variant, `<${index + 1}>`);
      }
    }
  }
  if (node && node.$ref) seen.delete(node.$ref);
}

/** Compose the generated document from the parsed schema. */
export function renderConfigDoc(schema) {
  const resolveRef = makeResolver(schema);
  const parts = [
    '# Phantom config reference',
    '',
    'Generated from `schema/config.schema.json` by `scripts/generate-config-docs.mjs`;',
    'do not edit by hand. After changing the schema, regenerate:',
    '',
    '    node scripts/generate-config-docs.mjs',
    '',
    'The drift guard `test/config-docs-drift.test.ts` fails when this file no',
    'longer matches the schema. `~/.ashlr/config.json` is validated against the',
    'schema at load time; the schema declares no defaults, so applied defaults',
    'live in `src/core/config.ts` and are outside this table. `[]` marks array',
    'elements, `*` additionalProperties map values, `/<regex>/` pattern keys and',
    '`<n>` oneOf/anyOf variant positions. "no" marks optional keys and `-`',
    'marks positions a parent object cannot require.',
    '',
    '## Top-level keys',
    '',
    '| Key | Type | Required | Description |',
    '| --- | --- | --- | --- |',
  ];
  const topRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
  const sections = [];
  for (const [key, node] of Object.entries(schema.properties ?? {})) {
    const rows = [...schemaRows(node, { path: key, emit: false, resolveRef })];
    parts.push(
      `| \`${cell(key)}\` | ${describeType(node, resolveRef)} | ${topRequired.has(key) ? 'yes' : 'no'} | ${cell(node?.description)} |`,
    );
    if (rows.length > 0) {
      const target = node && node.$ref ? resolveRef(node.$ref) : node;
      sections.push({
        key,
        description: typeof target?.description === 'string' ? target.description : '',
        rows,
      });
    }
  }
  for (const section of sections) {
    parts.push('', `## \`${section.key}\``, '');
    if (section.description !== '') parts.push(cell(section.description), '');
    parts.push('| Path | Type | Required | Description |', '| --- | --- | --- | --- |');
    for (const row of section.rows) {
      parts.push(`| \`${cell(row.path)}\` | ${row.type} | ${row.required} | ${cell(row.description)} |`);
    }
  }
  return `${parts.join('\n')}\n`;
}

/** Load the schema and return the full document text. */
export function buildConfigDocs({ repoRoot = REPO_ROOT } = {}) {
  const schema = JSON.parse(readFileSync(join(repoRoot, SCHEMA_PATH), 'utf8'));
  return renderConfigDoc(schema);
}

/** Compare the committed doc with fresh output without writing anything. */
export function checkConfigDocs(repoRoot = REPO_ROOT) {
  const docPath = join(repoRoot, CONFIG_DOC_PATH);
  const actual = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';
  const expected = buildConfigDocs({ repoRoot });
  return { ok: actual === expected, docPath, expected, actual };
}

/** First differing line between two texts, or null when identical. */
export function firstDiff(actual, expected) {
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const count = Math.max(actualLines.length, expectedLines.length);
  for (let i = 0; i < count; i += 1) {
    if (actualLines[i] !== expectedLines[i]) {
      return { line: i + 1, actual: actualLines[i], expected: expectedLines[i] };
    }
  }
  return null;
}

function main(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: node scripts/generate-config-docs.mjs [--check]');
    console.log('  (no args) rewrite docs/CONFIG-REFERENCE.md from schema/config.schema.json');
    console.log('  --check   compare only; exit 1 when the doc is stale');
    return 0;
  }
  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    console.error(`unknown argument ${unknown[0]}; usage: node scripts/generate-config-docs.mjs [--check]`);
    return 2;
  }
  if (args.includes('--check')) {
    const result = checkConfigDocs();
    if (result.ok) {
      console.log(`${CONFIG_DOC_PATH} is up to date.`);
      return 0;
    }
    console.error(`${CONFIG_DOC_PATH} is stale or missing; run \`node scripts/generate-config-docs.mjs\`.`);
    const diff = firstDiff(result.actual, result.expected);
    if (diff) {
      console.error(`first difference at line ${diff.line}:`);
      console.error(`  committed: ${diff.actual ?? '<missing>'}`);
      console.error(`  generated: ${diff.expected ?? '<missing>'}`);
    }
    return 1;
  }
  const doc = buildConfigDocs();
  writeFileSync(join(REPO_ROOT, CONFIG_DOC_PATH), doc);
  console.log(`wrote ${CONFIG_DOC_PATH} (${doc.split('\n').length - 1} lines)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`generate-config-docs: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
