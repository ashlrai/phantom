import test from 'node:test';
import assert from 'node:assert/strict';
import { hashParts, proveReuse, receiptFor } from '../scripts/ci-green-reuse.mjs';

test('a matching receipt proves reuse and every other receipt is a miss', () => {
  const hash = hashParts(['typecheck', 'abc']);
  const job = 'typecheck-backend';
  assert.equal(proveReuse(receiptFor(job, hash), job, hash), true);
  assert.equal(proveReuse('', job, hash), false);
  assert.equal(proveReuse('{}', job, hash), false);
  assert.equal(proveReuse(receiptFor(job, hash), 'typecheck-web', hash), false);
  assert.equal(proveReuse(receiptFor(job, hash), job, hashParts(['other'])), false);
  assert.equal(proveReuse(receiptFor(job, hash).replace('success', 'failure'), job, hash), false);
  const extra = JSON.parse(receiptFor(job, hash));
  extra.note = 'forged';
  assert.equal(proveReuse(JSON.stringify(extra), job, hash), false);
  assert.equal(proveReuse(receiptFor(job, hash), job, 'not-a-hash'), false);
});

test('hash parts change when any input changes and ignore part boundaries', () => {
  assert.equal(hashParts(['ab', 'c']), hashParts(['ab', 'c']));
  assert.notEqual(hashParts(['ab', 'c']), hashParts(['a', 'bc']));
  assert.notEqual(hashParts(['a']), hashParts(['a', '']));
});
