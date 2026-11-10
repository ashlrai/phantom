/* global process */
// Rewrite a git tag ref so its object is the peeled commit. Lightweight tags
// are already commits. Annotated tags are followed, at most four deep.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;

export function peelReleaseTag(ref, readAnnotation) {
  assert.equal(typeof ref?.ref, 'string');
  let object = ref.object;
  const seen = new Set();
  for (let depth = 0; object?.type === 'tag'; depth += 1) {
    assert.ok(depth < 4 && SHA.test(object.sha) && !seen.has(object.sha), 'invalid tag annotation');
    seen.add(object.sha);
    const tag = readAnnotation(object.sha);
    assert.equal(tag?.sha, object.sha, 'tag annotation sha mismatches');
    object = tag.object;
  }
  assert.equal(object?.type, 'commit', 'release tag does not peel to a commit');
  assert.match(object.sha ?? '', SHA, 'tag sha mismatches candidate');
  return { ...ref, object: { type: 'commit', sha: object.sha } };
}

function ghAnnotation(sha) {
  const repository = process.env.GITHUB_REPOSITORY;
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/);
  return JSON.parse(execFileSync('gh', ['api', `repos/${repository}/git/tags/${sha}`], { encoding: 'utf8' }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const file = process.argv[2];
  assert.equal(process.argv.length, 3);
  const peeled = peelReleaseTag(JSON.parse(readFileSync(file, 'utf8')), ghAnnotation);
  writeFileSync(file, `${JSON.stringify(peeled)}\n`);
}
