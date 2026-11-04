// Tag -> draft GitHub release, the leg of the release train that never ran.
// Called from auto-tag.yml only after every required check is green on the
// exact candidate commit and only ever with the ashlr-release App token.
// Idempotent: an existing tag must point at the candidate commit, an existing
// release is left untouched. The release starts as a DRAFT so releases/latest
// keeps resolving to the last fully stocked feed; the sanctioned local
// publisher (scripts/publish-desktop-release.mjs) attaches the signed
// artifacts and flips it public.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;

/** Every GitHub write goes through this one shape so tests can record it. */
export async function createTagAndDraftRelease({ repo, version, sha, read, write }) {
  assert.match(repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'unexpected repository name');
  const tag = `v${version}`;
  assert.ok(TAG.test(tag), 'unexpected release tag');
  assert.ok(SHA.test(sha), 'candidate revision must be an exact commit SHA');
  const base = `repos/${repo}`;
  const ref = await read(`${base}/git/ref/tags/${tag}`);
  if (ref === null) {
    await write('POST', `${base}/git/refs`, { ref: `refs/tags/${tag}`, sha });
  } else {
    assert.equal(ref.ref, `refs/tags/${tag}`, 'tag reference mismatch');
    assert.equal(ref.object?.type, 'commit', 'tag does not point at a commit');
    assert.equal(ref.object?.sha, sha, 'existing tag points at a different commit');
  }
  const existing = await read(`${base}/releases/tags/${tag}`);
  if (existing !== null) return { tag, sha, release: 'exists', releaseId: existing.id };
  const latest = await read(`${base}/releases/latest`);
  const fields = {
    tag_name: tag, target_commitish: sha, name: `Phantom ${version}`,
    draft: true, prerelease: false, generate_notes: true,
  };
  if (object(latest) && TAG.test(latest.tag_name ?? '')) fields.notes_start_tag = latest.tag_name;
  const created = await write('POST', `${base}/releases`, fields);
  assert.equal(object(created)?.draft, true, 'release did not land as a draft');
  return { tag, sha, release: 'draft-created', releaseId: created.id };
}

function ghApi(args) {
  return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', ...args],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: process.env }));
}

/** 404 is the only tolerated absence; every other failure is fatal. */
async function readOrNull(endpoint) {
  try { return ghApi([endpoint]); }
  catch (error) {
    const status = Number(/HTTP\s+(\d{3})/.exec(error.stderr?.toString() ?? '')?.[1] ?? error.status);
    if (status === 404) return null;
    throw error;
  }
}

async function main() {
  const { REPO, SHA: sha, VERSION } = process.env;
  if (!REPO || !VERSION || !SHA.test(sha ?? '')) {
    console.error('tag-github-release: REPO, VERSION and a 40-hex SHA are required');
    process.exitCode = 1; return;
  }
  const result = await createTagAndDraftRelease({
    repo: REPO, version: VERSION, sha,
    read: readOrNull,
    write: async (method, endpoint, fields) => {
      const args = ['-X', method, endpoint];
      for (const [key, value] of Object.entries(fields)) args.push('-F', `${key}=${value}`);
      return ghApi(args);
    },
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
