/* global process, console */
// Tag -> draft GitHub release, the leg of the release train that never ran.
// Called from auto-tag.yml only after every required check is green on the
// exact candidate commit and only ever with the ashlr-release App token.
// Idempotent: an existing tag is immutable and must be the candidate commit or
// one of its ancestors (a later master commit carrying the same version), in
// which case the release is cut at the tag's commit. An existing release —
// draft or published — is reused, never duplicated. The release starts as a
// DRAFT so releases/latest keeps resolving to the last fully stocked feed; the
// sanctioned local publisher (scripts/publish-desktop-release.mjs) attaches
// the signed artifacts and flips it public.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;

/** HTTP status from a gh-style error (stderr text or a .status test double). */
const httpStatus = (error) =>
  Number(/HTTP\s+(\d{3})/.exec(String(error?.stderr ?? ''))?.[1] ?? error?.status ?? NaN);

/** GET releases/tags/{tag} only returns PUBLISHED releases — drafts answer 404
 * there, which let every leg of the train mint a fresh draft per run. The list
 * endpoint does include drafts for tokens with push access, so dedup scans it.
 * With several matches (the duplicate-draft state this repaired) the canonical
 * row is the published one when present, else the highest id, so every caller
 * converges on the same release. */
export async function releaseForTag(read, base, tag) {
  let found = null;
  for (let page = 1; ; page++) {
    const rows = await read(`${base}/releases?per_page=100&page=${page}`);
    assert.ok(Array.isArray(rows), 'release listing did not return an array');
    for (const row of rows) {
      if (object(row)?.tag_name !== tag) continue;
      if (found === null || (found.draft === row.draft ? row.id > found.id : found.draft)) found = row;
    }
    if (rows.length < 100) return found;
  }
}

/** Every GitHub write goes through this one shape so tests can record it. */
export async function createTagAndDraftRelease({ repo, version, sha, read, write }) {
  assert.match(repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'unexpected repository name');
  const tag = `v${version}`;
  assert.ok(TAG.test(tag), 'unexpected release tag');
  assert.ok(SHA.test(sha), 'candidate revision must be an exact commit SHA');
  const base = `repos/${repo}`;
  const ref = await read(`${base}/git/ref/tags/${tag}`);
  let target = sha;
  if (ref === null) {
    await write('POST', `${base}/git/refs`, { ref: `refs/tags/${tag}`, sha });
  } else {
    assert.equal(ref.ref, `refs/tags/${tag}`, 'tag reference mismatch');
    assert.equal(ref.object?.type, 'commit', 'tag does not point at a commit');
    assert.ok(SHA.test(ref.object?.sha ?? ''), 'tag points at an invalid revision');
    if (ref.object.sha !== sha) {
      // Tags never move. Accept only a tag that is an ancestor of the candidate.
      const cmp = await read(`${base}/compare/${ref.object.sha}...${sha}`);
      assert.equal(object(cmp)?.status, 'ahead', 'existing tag points at a different commit');
      target = ref.object.sha;
    }
  }
  const existing = await releaseForTag(read, base, tag);
  if (existing !== null) return { tag, sha: target, release: 'exists', releaseId: existing.id };
  const latest = await read(`${base}/releases/latest`);
  const fields = {
    tag_name: tag, target_commitish: target, name: `Phantom ${version}`,
    draft: true, prerelease: false, generate_notes: true,
  };
  if (object(latest) && TAG.test(latest.tag_name ?? '')) fields.notes_start_tag = latest.tag_name;
  let created;
  try {
    created = await write('POST', `${base}/releases`, fields);
  } catch (error) {
    // A parallel leg that passed the same empty lookup may have won the create
    // race — or our own release may have landed while the response was lost.
    // Adopt the release that exists now instead of minting a second one.
    const raced = await releaseForTag(read, base, tag);
    if (raced === null) throw error;
    return { tag, sha: target, release: 'exists', releaseId: raced.id };
  }
  assert.equal(object(created)?.draft, true, 'release did not land as a draft');
  return { tag, sha: target, release: 'draft-created', releaseId: created.id };
}

function ghApi(args) {
  return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', ...args],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: process.env }));
}

/** 404 is the only tolerated absence; every other failure is fatal. */
async function readOrNull(endpoint) {
  try { return ghApi([endpoint]); }
  catch (error) {
    if (httpStatus(error) === 404) return null;
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
