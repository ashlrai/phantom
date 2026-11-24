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

const tagRef = { ref: 'refs/tags/v3.30.72', object: { type: 'commit', sha } };

function readForRelease(release) {
  return async (url) => {
    if (url.includes('/git/ref/tags/')) return tagRef;
    if (url.includes('/releases?')) return [release];
    return null;
  };
}

test('blank existing draft is filled in place with a body-only PATCH', async () => {
  const writes = [];
  const existing = { id: 42, draft: true, tag_name: 'v3.30.72', body: '' };
  const write = async (method, endpoint, fields) => {
    writes.push({ method, endpoint, fields });
    if (String(endpoint).endsWith('/generate-notes')) {
      return { name: 'Phantom 3.30.72', body: '## Changes\n- fix cookie advisory' };
    }
    return { id: 42, draft: true, body: fields.body };
  };
  const result = await createTagAndDraftRelease({
    repo: 'ashlrai/phantom', version: '3.30.72', sha,
    read: readForRelease(existing), write,
  });
  assert.equal(result.release, 'exists');
  assert.equal(result.releaseId, 42);
  const notes = writes.find((row) => String(row.endpoint).endsWith('/generate-notes'));
  assert.ok(notes, 'expected POST /releases/generate-notes');
  assert.equal(notes.method, 'POST');
  assert.deepEqual(notes.fields, { tag_name: 'v3.30.72', target_commitish: sha });
  const patch = writes.filter((row) => row.method === 'PATCH');
  assert.equal(patch.length, 1);
  assert.equal(patch[0].endpoint, 'repos/ashlrai/phantom/releases/42');
  assert.deepEqual(patch[0].fields, { body: '## Changes\n- fix cookie advisory' });
  assert.equal(writes.some((row) => row.method === 'POST' && String(row.endpoint).endsWith('/releases')), false);
});

test('null or whitespace-only draft bodies are also treated as blank', async () => {
  for (const body of [null, '  \n\t']) {
    const writes = [];
    const existing = { id: 8, draft: true, tag_name: 'v3.30.72', body };
    const write = async (method, endpoint, fields) => {
      writes.push({ method, endpoint, fields });
      if (String(endpoint).endsWith('/generate-notes')) return { body: '## Notes' };
      return { id: 8 };
    };
    const result = await createTagAndDraftRelease({
      repo: 'ashlrai/phantom', version: '3.30.72', sha,
      read: readForRelease(existing), write,
    });
    assert.equal(result.release, 'exists');
    assert.equal(writes.some((row) => row.method === 'PATCH' && Object.keys(row.fields).join() === 'body'), true, `expected a body-only PATCH for ${JSON.stringify(body)}`);
  }
});

test('an existing draft with edited notes is left unchanged', async () => {
  const writes = [];
  const existing = { id: 42, draft: true, tag_name: 'v3.30.72', body: 'Already written by a human.' };
  const result = await createTagAndDraftRelease({
    repo: 'ashlrai/phantom', version: '3.30.72', sha,
    read: readForRelease(existing),
    write: async (method, endpoint, fields) => {
      writes.push({ method, endpoint, fields });
      return {};
    },
  });
  assert.equal(result.release, 'exists');
  assert.equal(result.releaseId, 42);
  assert.deepEqual(writes, []);
});

test('a published release, even with a blank body, is not patched', async () => {
  const writes = [];
  const existing = { id: 42, draft: false, tag_name: 'v3.30.72', body: '' };
  const result = await createTagAndDraftRelease({
    repo: 'ashlrai/phantom', version: '3.30.72', sha,
    read: readForRelease(existing),
    write: async (method, endpoint, fields) => {
      writes.push({ method, endpoint, fields });
      return {};
    },
  });
  assert.equal(result.release, 'exists');
  assert.equal(result.releaseId, 42);
  assert.deepEqual(writes, []);
});

test('a create race onto a blank draft fills notes instead of returning a silent exists', async () => {
  const writes = [];
  let listCalls = 0;
  const read = async (url) => {
    if (url.includes('/git/ref/tags/')) return null;
    if (url.includes('/releases?')) {
      listCalls += 1;
      return listCalls === 1 ? [] : [{ id: 7, draft: true, tag_name: 'v3.30.72', body: '' }];
    }
    return null;
  };
  const write = async (method, endpoint, fields) => {
    writes.push({ method, endpoint, fields });
    if (String(endpoint).includes('/git/refs')) return { ref: 'refs/tags/v3.30.72' };
    if (method === 'POST' && String(endpoint).endsWith('/releases')) {
      const error = new Error('already exists');
      error.status = 422;
      throw error;
    }
    if (String(endpoint).endsWith('/generate-notes')) return { body: '## Recovered notes' };
    return { id: 7 };
  };
  const result = await createTagAndDraftRelease({
    repo: 'ashlrai/phantom', version: '3.30.72', sha, read, write,
  });
  assert.equal(result.release, 'exists');
  assert.equal(result.releaseId, 7);
  const patch = writes.find((row) => row.method === 'PATCH');
  assert.ok(patch, 'expected a body-only PATCH after the create race');
  assert.deepEqual(patch.fields, { body: '## Recovered notes' });
});
