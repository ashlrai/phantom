import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const root = new URL('../contrib/nodes/lima/', import.meta.url);
const source = readFileSync(new URL('phantom-node.yaml', root), 'utf8');
const document = parseDocument(source, { uniqueKeys: true });
const template = document.toJS();
const schema = JSON.parse(readFileSync(new URL('phantom-node.schema.json', root), 'utf8'));
const validate = new AjvJsonSchemaValidator().getValidator(schema);

describe('offline constrained Lima schema and isolation profile', () => {
  it('parses without duplicate keys and conforms to the schema', () => {
    expect(document.errors).toEqual([]);
    const result = validate(template);
    expect(result.valid, result.errorMessage).toBe(true);
  });

  it.each([
    { mounts: [{ location: '~', writable: false }] },
    { base: ['template:default'] },
    { provision: [{ mode: 'system', script: 'echo unexpected' }] },
    { env: { TOKEN: 'placeholder' } },
    { propagateProxyEnv: true },
    { ssh: { ...template.ssh, forwardAgent: true } },
    { ssh: { ...template.ssh, loadDotSSHPubKeys: true } },
    { ssh: { ...template.ssh, forwardX11: true } },
    { portForwards: [] },
    { portForwards: [{ ...template.portForwards[0], ignore: false }] },
    { memory: '8GiB' },
    { disk: '10GiB' },
    { cpus: '2' },
    { images: [{ ...template.images[0], digest: 'sha256:invalid' }] },
    { images: [{ ...template.images[0], location: 'http://example.invalid/image' }] },
  ])('rejects unsafe or incompatible profile changes: %j', (override) => {
    expect(validate({ ...template, ...override }).valid).toBe(false);
  });

  it('requires every declared isolation control, not just permissive defaults', () => {
    for (const key of schema.required as string[]) {
      const altered = { ...template };
      delete altered[key];
      expect(validate(altered).valid, `missing ${key}`).toBe(false);
    }
  });
});
