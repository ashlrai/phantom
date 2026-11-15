import console from 'node:console';
import { readFileSync } from 'node:fs';
const { text } = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify({ lines: text === '' ? 0 : text.split('\n').length }));
