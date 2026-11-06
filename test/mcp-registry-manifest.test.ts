import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('server.json', root), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const schemaBytes = readFileSync(new URL('fixtures/mcp-registry/server.schema.json', import.meta.url));
const schema = JSON.parse(schemaBytes.toString('utf8'));
const validate = new AjvJsonSchemaValidator().getValidator(schema);

describe('MCP registry manifest', () => {
  it('validates offline against the unmodified published schema', () => {
    expect(manifest.$schema).toBe(schema.$id);
    expect(createHash('sha256').update(schemaBytes).digest('hex')).toBe(
      '3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0',
    );
    const result = validate(manifest);
    expect(result.valid, result.errorMessage).toBe(true);
  });

  it.each([
    { ...manifest, name: 'invalid namespace' },
    { ...manifest, packages: [{ ...manifest.packages[0], transport: { type: 'invalid' } }] },
    { ...manifest, websiteUrl: 'not a URI' },
    { ...manifest, version: 123 },
  ])('rejects an invalid manifest: %j', (invalid) => {
    expect(validate(invalid).valid).toBe(false);
  });

  it('pins the server and npm package to the source package version', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.packages).toHaveLength(1);
    expect(manifest.packages[0]).toMatchObject({
      identifier: pkg.name,
      version: pkg.version,
      registryType: 'npm',
      registryBaseUrl: 'https://registry.npmjs.org',
      runtimeHint: 'npx',
      transport: { type: 'stdio' },
      packageArguments: [{ type: 'positional', value: 'mcp', valueHint: 'subcommand' }],
    });
    // npm exec can select either alias because every bin has the same target.
    expect(new Set(Object.values(pkg.bin))).toEqual(new Set(['bin/ashlr']));
    expect(manifest.repository.url).toBe(pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''));
    expect(manifest.websiteUrl).toBe(pkg.homepage);
  });
});
