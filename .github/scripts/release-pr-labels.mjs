/* global Buffer, process, console */
// auto-tag owns tags, so release-please cannot clear its own pending labels.
// Reconcile only merged release PRs backed by an immutable, same-source tag.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireRepositoryMetadata, requireRepositoryReference } from './github-repository-binding.mjs';

export async function reconcileTaggedReleasePrs({ repository, read, write }) {
  const base = `repos/${repository}`;
  requireRepositoryMetadata(repository, await read(base));
  const planned = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await read(`${base}/issues?state=closed&labels=autorelease%3A%20pending&per_page=100&page=${page}`);
    assert.ok(Array.isArray(rows) && rows.length <= 100);
    for (const row of rows) {
      if (!row.pull_request) continue;
      assert.ok(Number.isSafeInteger(row.number) && row.number > 0);
      const pr = await read(`${base}/pulls/${row.number}`);
      if (!pr.merged_at || !pr.head?.ref?.startsWith('release-please--')) continue;
      requireRepositoryReference(repository, pr.head.repo); requireRepositoryReference(repository, pr.base.repo);
      assert.equal(pr.base.ref, 'master'); assert.match(pr.merge_commit_sha ?? '', /^[a-f0-9]{40}$/);
      const content = await read(`${base}/contents/package.json?ref=${pr.merge_commit_sha}`);
      assert.equal(content.encoding, 'base64');
      const pkg = JSON.parse(Buffer.from(content.content, 'base64').toString('utf8'));
      assert.equal(pkg.name, '@ashlr/phantom'); assert.match(pkg.version ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
      const tag = await read(`${base}/git/ref/tags/v${pkg.version}`);
      if (tag === null) continue;
      assert.equal(tag.ref, `refs/tags/v${pkg.version}`); assert.equal(tag.object?.type, 'commit');
      assert.match(tag.object.sha ?? '', /^[a-f0-9]{40}$/);
      if (tag.object.sha !== pr.merge_commit_sha) {
        const compare = await read(`${base}/compare/${pr.merge_commit_sha}...${tag.object.sha}`);
        assert.equal(compare.status, 'ahead', 'release tag does not descend from merged release PR');
        const tagged = await read(`${base}/contents/package.json?ref=${tag.object.sha}`);
        assert.equal(tagged.encoding, 'base64');
        const target = JSON.parse(Buffer.from(tagged.content, 'base64').toString('utf8'));
        assert.equal(target.name, pkg.name); assert.equal(target.version, pkg.version, 'release tag version differs');
      }
      planned.push(row.number);
    }
    if (rows.length < 100) break;
    assert.ok(page < 10, 'incomplete pending release PR inventory');
  }
  // Finish all reads before the first mutation. Add the tagged label first so a
  // partial API failure leaves pending in place and the next invocation retries.
  for (const number of planned) {
    await write('POST', `${base}/issues/${number}/labels`, { labels: ['autorelease: tagged'] });
    await write('DELETE', `${base}/issues/${number}/labels/autorelease%3A%20pending`);
  }
  return { reconciled: planned.length };
}

const api = (method, endpoint, payload) => {
  const output = execFileSync('gh', ['api', '--hostname', 'github.com', '-X', method, endpoint, ...(payload ? ['--input', '-'] : [])],
    { input: payload ? JSON.stringify(payload) : undefined, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
  return output.trim() ? JSON.parse(output) : null;
};
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.env.GITHUB_REF, 'refs/heads/master');
    const result = await reconcileTaggedReleasePrs({ repository: process.env.GITHUB_REPOSITORY,
      read: async endpoint => {
        try { return api('GET', endpoint); }
        catch (error) {
          if (endpoint.includes('/git/ref/tags/') && /HTTP 404/.test(String(error.stderr))) return null;
          throw error;
        }
      }, write: async (method, endpoint, payload) => api(method, endpoint, payload) });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
