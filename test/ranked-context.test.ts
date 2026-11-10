import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { companyRankedContextStore, readCompanyContext } from '../src/core/context/company-context-store.js';
import type { RankedContextItem, RankedContextStore } from '../src/core/context/ranked-context.js';

const directory = mkdtempSync(join(tmpdir(), 'ranked-context-'));
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const now = 1_700_000_000_000;
const item = (id: string, overrides: Partial<RankedContextItem> = {}): RankedContextItem => ({
  id, tenantId: 'tenant', ownerId: 'owner', text: 'A useful summary', createdAt: now,
  importance: 0.5, accuracy: 0.5, contentKind: 'summary', ...overrides,
});
const query = { tenantId: 'tenant', ownerId: 'owner', now, limit: 10 };
describe('company ranked context', () => {
  it('ranks recency, importance and accuracy and isolates both scopes', () => {
    const store: RankedContextStore = companyRankedContextStore(directory);
    store.put(item('old', { createdAt: now - 7 * 86400000 }));
    store.put(item('important', { importance: 1 }));
    store.put(item('accurate', { accuracy: 0.9 }));
    store.put(item('other-tenant', { tenantId: 'other' }));
    store.put(item('other-owner', { ownerId: 'other' }));
    expect(store.query(query).map(row => row.id)).toEqual(['important', 'accurate', 'old']);
    expect(readCompanyContext({}, directory).digest).toBe('');
    expect(companyRankedContextStore(directory).query({ ...query, ownerId: 'other' }).map(row => row.id)).toEqual(['other-owner']);
  });
  it('rejects credential shapes and screen payloads before persistence', () => {
    const store = companyRankedContextStore(directory);
    const credential = ['gh', 'p_', 'aB3'.repeat(10)].join('');
    for (const text of [credential, 'Screenshot: private window text', 'data:image/png;base64,abc']) {
      expect(() => store.put(item('bad', { text }))).toThrow();
    }
    expect(store.query(query)).toEqual([]);
  });
});
