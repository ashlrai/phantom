#!/usr/bin/env node
/**
 * One command, on a machine with a local Ollama embedding model (for example `ollama pull all-minilm`):
 *   npm run --silent bench:memory:embed [-- --model all-minilm]
 * Compares governed memory with and without the embedding signal on the bundled benchmark. Loopback Ollama only.
 * Exit 0 with a report; 3 when no local embedding model is reachable; 2 on bad arguments.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareMemoryEmbeddings } from '../src/core/local-eval/memory-benchmark-embeddings.js';
import { connectOllamaMemoryEmbedder, type MemoryEmbedder } from '../src/core/local-eval/memory-embeddings.js';

export function parseMemoryEmbedArgs(argv: string[]): { model?: string } | null {
  if (!argv.length) return {};
  return argv.length === 2 && argv[0] === '--model' && /^[\w.:/-]{1,128}$/.test(argv[1]) ? { model: argv[1] } : null;
}
export async function benchmarkMemoryEmbeddingsCli(argv: string[], connect: (model?: string) => Promise<MemoryEmbedder | null> =
  model => connectOllamaMemoryEmbedder({ baseUrl: process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST.replace(/^https?:\/\//, '')}` : undefined, model })): Promise<{ exitCode: number; output: unknown }> {
  const args = parseMemoryEmbedArgs(argv);
  if (!args) return { exitCode: 2, output: { code: 'MEMORY_BENCH_EMBED_ARGUMENTS', error: 'Usage: npm run --silent bench:memory:embed [-- --model NAME]' } };
  const embedder = await connect(args.model);
  const unavailable = { code: 'MEMORY_BENCH_EMBEDDINGS_UNAVAILABLE', error: 'No local Ollama embedding model is reachable on a loopback address. Install one (ollama pull all-minilm) and retry. Nothing was measured.' };
  if (!embedder) return { exitCode: 3, output: unavailable };
  const comparison = await compareMemoryEmbeddings(embedder);
  return comparison ? { exitCode: 0, output: comparison } : { exitCode: 3, output: { ...unavailable, model: embedder.model } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await benchmarkMemoryEmbeddingsCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result.output, null, 2) + '\n'); process.exitCode = result.exitCode;
}
