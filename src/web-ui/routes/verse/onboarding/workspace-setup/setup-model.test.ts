import { describe, expect, it } from 'vitest';
import { SETUP_PRODUCTS, reviewedMemoryDraft, workspaceSetupBrief } from './setup-model.js';
import { COMPANION_RELEASES } from '../../../../../core/companion-types.js';
import { readContextFile } from './ImportContextPane.js';
describe('workspace setup model', () => {
  it('separates the host from its exact three existing companion products', () => {
    expect(SETUP_PRODUCTS.map(product => product.id)).toEqual(['phantom', 'secrets', 'locus', 'lexicon']);
    expect(COMPANION_RELEASES.map(product => product.id)).toEqual(['secrets', 'locus', 'lexicon']);
    expect(SETUP_PRODUCTS.slice(1).map(product => product.release)).toEqual(COMPANION_RELEASES.map(product => product.releaseUrl));
  });
  it('drafts public setup guidance without credentials or automatic permissions', () => {
    const text = workspaceSetupBrief();
    expect(text).toContain('phm companions --json'); expect(text).toContain('Verify release artifacts before installing');
    expect(text).toContain('Do not silently grant permissions'); expect(text).toContain('Lexicon project trust/native voice service');
    expect(text).not.toContain('curl '); expect(text).not.toContain('API_KEY');
  });
  it('keeps rewritten facts separate from raw references and grants', () => {
    expect(reviewedMemoryDraft('Claude · reference-1', 'Use concise progress updates.')).toContain('Use concise progress updates.');
    expect(reviewedMemoryDraft('Claude', 'A fact.')).toContain('grant no authority');
  });
  it('refuses invalid UTF-8 and preserves valid source bytes including a BOM', async () => {
    const invalid = new Uint8Array([0xc3, 0x28]);
    await expect(readContextFile({ name: 'history.txt', size: 2, arrayBuffer: async () => invalid.buffer } as File)).rejects.toThrow('not valid UTF-8');
    const valid = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
    const decoded = await readContextFile({ name: 'history.txt', size: valid.length, arrayBuffer: async () => valid.buffer } as File);
    expect(Array.from(new TextEncoder().encode(decoded))).toEqual(Array.from(valid));
  });
  it('refuses large files or archives before reading anything', async () => {
    let reads = 0;
    for (const [name, size] of [['context.txt', 8 * 1024 * 1024 + 1], ['history.zip', 1], ['history.html', 1]]) {
      await expect(readContextFile({ name, size, arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } } as File)).rejects.toThrow();
    }
    expect(reads).toBe(0);
  });
});
