import { buildNodeContextPack, } from './src/core/fleet/node-context-pack.js';

function input(patch = {}) {
  return {
    node: { jobId: 'node-a', upstreamJobIds: ['job-1', 'job-2', 'job-3', 'job-4', 'job-1'], query: 'test' },
    outputs: [
      { jobId: 'job-1', text: 'First output data.' },
      { jobId: 'job-2', text: '' },
      { jobId: 'job-3', text: '  ' },
      { jobId: 'node-a', text: 'Own output. Do not count.' },
      ...(patch.outputs ?? []),
    ],
    tasks: [{ jobId: 'task-1', text: 'A task about test.' }],
    byteBudget: 500,
  };
}

// Test 1: truncated
const i = input({ outputs: [{ jobId: 'job-1', text: 'x'.repeat(200) }] });
const pack = buildNodeContextPack({ ...i, byteBudget: 80 });
console.log('=== Test 1: truncated ===');
console.log('Pack length:', Buffer.byteLength(pack));
console.log('Pack lines:', pack.trimEnd().split('\n').length);
for (const line of pack.trimEnd().split('\n')) {
  if (line) {
    const obj = JSON.parse(line);
    console.log('  entry:', JSON.stringify(obj).slice(0, 200));
  }
}

// Test 2: malformed
const malformed = 'not json\n{"jobId":"job-1","kind":"output","text":"data","truncated":false}\n{bad\n';
console.log('\n=== Test 2: malformed ===');
for (const line of malformed.trimEnd().split('\n')) {
  try {
    const obj = JSON.parse(line);
    console.log('  valid entry:', JSON.stringify(obj));
  } catch {}
}

// Test 3: empty pack
console.log('\n=== Test 3: empty pack ===');
const i3 = input();
console.log('job-1 hasNonBlank:', !!i3.outputs.find(o => o.jobId === 'job-1')?.text.trim());
