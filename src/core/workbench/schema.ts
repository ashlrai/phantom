// workbench.v1 schema validator (RQ-DESK-1-SCHEMA). Supports only the JSON Schema
// subset used by schema/workbench.v1: type, enum, pattern, required, properties,
// additionalProperties:false, items, maxItems, minimum, maximum, maxLength, $ref.
// Fail closed: any unknown key in data is an error. Errors carry paths, never values.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Schema = Record<string, unknown>;
export const WORKBENCH_SCHEMAS = ['snapshot', 'action', 'action-result', 'audit-row', 'event'] as const;
export type WorkbenchSchemaName = (typeof WORKBENCH_SCHEMAS)[number];

export function loadWorkbenchSchema(dir: string, name: string): Schema {
  return JSON.parse(readFileSync(join(dir, `${name.replace(/\.schema\.json$/, '')}.schema.json`), 'utf8')) as Schema;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

export function validateWorkbench(dir: string, name: WorkbenchSchemaName, data: unknown): string[] {
  const errors: string[] = [];
  const root = loadWorkbenchSchema(dir, name);
  const walk = (s: Schema, v: unknown, path: string, doc: Schema): void => {
    const ref = s.$ref as string | undefined;
    if (ref) {
      if (ref.startsWith('#/$defs/')) return walk((doc.$defs as Record<string, Schema>)[ref.slice(8)], v, path, doc);
      const other = loadWorkbenchSchema(dir, ref);
      return walk(other, v, path, other);
    }
    const t = typeOf(v);
    if (s.type !== undefined) {
      const allowed = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!allowed.includes(t) && !(t === 'integer' && allowed.includes('number'))) {
        errors.push(`${path}: type`);
        return;
      }
    }
    if (Array.isArray(s.enum) && !s.enum.includes(v as never)) errors.push(`${path}: enum`);
    if (typeof v === 'string') {
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) errors.push(`${path}: pattern`);
      if (typeof s.maxLength === 'number' && v.length > s.maxLength) errors.push(`${path}: maxLength`);
    }
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) errors.push(`${path}: minimum`);
      if (typeof s.maximum === 'number' && v > s.maximum) errors.push(`${path}: maximum`);
    }
    if (Array.isArray(v)) {
      if (typeof s.maxItems === 'number' && v.length > s.maxItems) errors.push(`${path}: maxItems`);
      if (s.items) v.forEach((item, i) => walk(s.items as Schema, item, `${path}[${i}]`, doc));
    }
    if (t === 'object') {
      const obj = v as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, Schema>;
      for (const key of (s.required ?? []) as string[]) if (!(key in obj)) errors.push(`${path}.${key}: required`);
      for (const [key, val] of Object.entries(obj)) {
        if (props[key]) walk(props[key], val, `${path}.${key}`, doc);
        else if (s.additionalProperties === false) errors.push(`${path}: unknown key`);
      }
    }
  };
  walk(root, data, '$', root);
  return errors;
}
