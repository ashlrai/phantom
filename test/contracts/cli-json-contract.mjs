import { readFileSync, statSync } from 'node:fs';
import { URL } from 'node:url';

const schemaNames = {
  locus: 'locus-agent-report',
  lexicon: 'lexicon-handshake',
  'phantom-secrets': 'phantom-secrets-status',
};
export const products = Object.freeze(Object.keys(schemaNames));
const annotations = ['$schema', '$id', 'title', 'description', '$defs'];
const supported = new Set([...annotations, '$ref', 'type', 'const', 'enum', 'required',
  'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'pattern']);

export function loadSchema(product) {
  if (!Object.hasOwn(schemaNames, product)) throw new Error('Unknown contract product');
  return readJson(new URL(`./schemas/${schemaNames[product]}.schema.json`, import.meta.url));
}

export function readJson(path) {
  // Never include producer stdout or parser diagnostics in a failure: even an
  // incompatible producer may accidentally emit private data.
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > 1_048_576) throw new Error('Expected a JSON file of at most 1 MiB');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Expected exactly one JSON document');
  }
}

// Deliberately bounded JSON Schema subset for these fixtures, not a general
// validator. Reject unsupported keywords rather than silently ignoring a new
// constraint when a producer schema is refreshed. No remote $ref resolution.
export function assertSupportedSchema(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Expected an object schema');
  for (const key of Object.keys(schema)) {
    if (!supported.has(key)) throw new Error('Unsupported schema keyword; extend the checker before refreshing');
  }
  if (schema.$ref && !/^#\/\$defs\/[A-Za-z0-9]+$/.test(schema.$ref)) throw new Error('Only local definition references are supported');
  if (schema.type && ![schema.type].flat().every(type => ['object', 'array', 'string', 'boolean', 'integer', 'null'].includes(type))) {
    throw new Error('Unsupported schema type');
  }
  for (const group of [schema.properties, schema.$defs]) {
    for (const child of Object.values(group ?? {})) assertSupportedSchema(child);
  }
  if (Object.hasOwn(schema, 'items')) assertSupportedSchema(schema.items);
  if (typeof schema.additionalProperties === 'object') assertSupportedSchema(schema.additionalProperties);
}

export function validateJson(schema, value) {
  assertSupportedSchema(schema);
  const errors = [];
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const matchesType = (v, type) => type === 'null' ? v === null
    : type === 'integer' ? Number.isSafeInteger(v)
      : type === 'array' ? Array.isArray(v)
        : type === 'object' ? isObject(v) : typeof v === type;
  function visit(rule, v, path) {
    if (rule.$ref) {
      const target = schema.$defs?.[rule.$ref.split('/').at(-1)];
      if (!target) throw new Error('Unresolved local schema reference');
      visit(target, v, path);
    }
    if (rule.type && ![rule.type].flat().some(type => matchesType(v, type))) {
      errors.push(`${path}: type changed`);
      return;
    }
    if (Object.hasOwn(rule, 'const') && v !== rule.const) errors.push(`${path}: constant changed`);
    if (rule.enum && !rule.enum.includes(v)) errors.push(`${path}: unsupported enum`);
    if (typeof v === 'string' && rule.pattern && !new RegExp(rule.pattern, 'u').test(v)) errors.push(`${path}: pattern mismatch`);
    if (Array.isArray(v)) {
      if (rule.minItems !== undefined && v.length < rule.minItems) errors.push(`${path}: too few items`);
      if (rule.maxItems !== undefined && v.length > rule.maxItems) errors.push(`${path}: too many items`);
      if (rule.uniqueItems && new Set(v.map(item => JSON.stringify(item))).size !== v.length) errors.push(`${path}: duplicate items`);
      if (rule.items) v.forEach(item => visit(rule.items, item, `${path}[]`));
    }
    if (isObject(v)) {
      for (const key of rule.required ?? []) {
        if (!Object.hasOwn(v, key)) errors.push(`${path}.${key}: missing required field`);
      }
      for (const [key, child] of Object.entries(v)) {
        if (Object.hasOwn(rule.properties ?? {}, key)) visit(rule.properties[key], child, `${path}.${key}`);
        else if (rule.additionalProperties === false) errors.push(`${path}: unexpected field`);
        // Unknown map keys come from producer output; never echo them.
        else if (typeof rule.additionalProperties === 'object') visit(rule.additionalProperties, child, `${path}.*`);
      }
    }
  }
  visit(schema, value, '$');
  return errors;
}

export function checkContract(product, value, exitCode) {
  const errors = validateJson(loadSchema(product), value);
  if (product === 'locus') {
    const expected = { ready: 0, protected: 1, unsafe: 2 }[value?.status];
    if (expected === undefined || exitCode !== expected || value.exit_code !== expected) errors.push('$: status/exit code mismatch');
    if (value?.ready !== (value?.status === 'ready')) errors.push('$.ready: inconsistent readiness');
    if (!Array.isArray(value?.required_servers) || !['locus', 'phantom'].every(name => value.required_servers.includes(name))) {
      errors.push('$.required_servers: identity/secrets pair missing');
    }
  } else if (product === 'lexicon') {
    if (exitCode !== 0) errors.push('$: expected successful CLI exit');
    if (value?.health?.status === 'ok' && Array.isArray(value.health.checks) && value.health.checks.some(check => check?.status === 'missing')) {
      errors.push('$.health: missing dependency reported as healthy');
    }
  } else if (exitCode !== 0) errors.push('$: expected successful CLI exit');
  return errors;
}
