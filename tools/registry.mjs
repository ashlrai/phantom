#!/usr/bin/env node
// Repository tool registry. Manifests and scripts are trusted repository code.
import process from 'node:process';
import console from 'node:console';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const namePattern = /^[a-z][a-z0-9-]*$/;

export function discover(registry = root) {
  const manifests = readdirSync(registry).filter((name) => name.endsWith('.tool.json')).sort();
  const seen = new Set();
  return manifests.map((file) => {
    const item = JSON.parse(readFileSync(resolve(registry, file), 'utf8'));
    if (!item || typeof item !== 'object' || !namePattern.test(item.name) || seen.has(item.name) ||
        typeof item.description !== 'string' || !item.description.trim() ||
        !['read-only', 'dangerous'].includes(item.safetyClass) ||
        typeof item.entrypoint !== 'string' || isAbsolute(item.entrypoint) ||
        !item.inputSchema || item.inputSchema.type !== 'object' ||
        !item.inputSchema.properties || typeof item.inputSchema.properties !== 'object' ||
        Array.isArray(item.inputSchema.properties) || item.inputSchema.additionalProperties !== false ||
        !Array.isArray(item.inputSchema.required) ||
        item.inputSchema.required.some((key) => typeof key !== 'string' || !Object.hasOwn(item.inputSchema.properties, key)) ||
        Object.values(item.inputSchema.properties).some((property) => !property || property.type !== 'string')) {
      throw new Error(`Invalid manifest: ${file}`);
    }
    seen.add(item.name);
    const base = realpathSync(registry);
    const target = realpathSync(resolve(base, item.entrypoint));
    const rel = relative(base, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !target.endsWith('.mjs')) {
      throw new Error(`Invalid entrypoint: ${file}`);
    }
    return { ...item, entrypoint: rel };
  });
}

export function validateInput(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be an object');
  for (const key of schema.required) if (!Object.hasOwn(input, key)) throw new Error(`Missing input: ${key}`);
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(schema.properties, key) || typeof value !== 'string') throw new Error(`Invalid input: ${key}`);
  }
}

export function run(args, registry = root) {
  const [command, name, raw, ...extra] = args;
  const items = discover(registry);
  if (command === 'list' && !name) { console.log(JSON.stringify(items, null, 2)); return 0; }
  if (command !== 'run' || !name || raw === undefined || extra.length) throw new Error('Usage: node tools/registry.mjs list | run <name> <json-object>');
  const item = items.find((tool) => tool.name === name);
  if (!item) throw new Error(`Unknown tool: ${name}`);
  if (item.safetyClass === 'dangerous') throw new Error('Leader approval required; dangerous tool execution is not yet supported');
  const input = JSON.parse(raw);
  validateInput(item.inputSchema, input);
  const result = spawnSync(process.execPath, [resolve(registry, item.entrypoint)], {
    cwd: process.cwd(), input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH ?? '' },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
