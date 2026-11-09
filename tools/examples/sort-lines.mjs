import console from 'node:console';
import { readFileSync } from 'node:fs';
const { text } = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify({ text: text.split('\n').sort().join('\n') }));
