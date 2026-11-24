import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTagAndDraftRelease } from '../scripts/tag-github-release.mjs';

const sha = 'a'.repeat(40);

test('new draft requests official generate_release_notes and stays a draft', async () => {
  const writes = [];
  const read = async (url) => {
    if (url.includes('/git/ref/tags/')) return null;
    if (url.includes('/releases?')) return [];
    if (url.includes('/releases/latest')) return { tag_name: 'v3.30.71' };
    return null;
  };
  const write = async (method, endpoint, fields) => {
    writes.push({ method, endpoint, fields });
    if (String(endpoint).includes('/git/refs')) return { ref: 'refs/tags/v3.30.72' };
    return { id: 99, draft: true, tag_name: 'v3.30.72' };
  };
  const result = await createTagAndDraftRelease({
    repo: 'ashlrai/phantom', version: '3.30.72', sha, read, write,
  });
  assert.equal(result.release, 'draft-created');
  assert.equal(result.releaseId, 99);
  const created = writes.find((row) => String(row.endpoint).endsWith('/releases'));
  assert.ok(created, 'expected a POST to create the draft release');
  assert.equal(created.method, 'POST');
  assert.equal(created.fields.draft, true);
  assert.equal(created.fields.prerelease, false);
  assert.equal(created.fields.generate_release_notes, true);
  assert.equal(Object.hasOwn(created.fields, 'generate_notes'), false);
  assert.equal(Object.hasOwn(created.fields, 'notes_start_tag'), false);
});
