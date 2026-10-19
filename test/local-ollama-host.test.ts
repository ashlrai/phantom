import { describe, expect, it } from 'vitest';
import { localOllamaBase } from '../src/core/local-ollama-host.js';

const DEFAULT = 'http://localhost:11434';
const at = (v: string | undefined) => localOllamaBase({ OLLAMA_HOST: v });

describe('localOllamaBase: defaults are unchanged', () => {
  it('unset, empty and whitespace give the default', () => {
    expect(localOllamaBase({})).toBe(DEFAULT);
    for (const v of [undefined, '', '   ', '/', ' // ']) expect(at(v)).toBe(DEFAULT);
  });
  it('a custom fallback is returned instead of the default', () => {
    expect(localOllamaBase({}, 'http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(localOllamaBase({ OLLAMA_HOST: 'gpu-box:1' }, 'http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
  });
  it('reads process.env by default', () => {
    const saved = process.env['OLLAMA_HOST'];
    try {
      delete process.env['OLLAMA_HOST'];
      expect(localOllamaBase()).toBe(DEFAULT);
      process.env['OLLAMA_HOST'] = '127.0.0.1:11500';
      expect(localOllamaBase()).toBe('http://127.0.0.1:11500');
    } finally {
      if (saved === undefined) delete process.env['OLLAMA_HOST'];
      else process.env['OLLAMA_HOST'] = saved;
    }
  });
});

describe('localOllamaBase: accepted forms on loopback', () => {
  it('host, host:port, :port and a URL', () => {
    expect(at('localhost')).toBe('http://localhost:11434');
    expect(at('localhost:11500')).toBe('http://localhost:11500');
    expect(at(':11500')).toBe('http://localhost:11500');
    expect(at('127.0.0.1')).toBe('http://127.0.0.1:11434');
    expect(at('127.0.0.1:9999')).toBe('http://127.0.0.1:9999');
    expect(at('http://127.0.0.1:9999')).toBe('http://127.0.0.1:9999');
    expect(at('HTTP://LOCALHOST:5')).toBe('http://LOCALHOST:5');
    expect(at('https://localhost:8443/')).toBe('https://localhost:8443');
    expect(at('  localhost:11500//  ')).toBe('http://localhost:11500');
  });
  it('the whole 127/8 block and IPv6 loopback', () => {
    expect(at('127.1.2.3:1')).toBe('http://127.1.2.3:1');
    expect(at('[::1]')).toBe('http://[::1]:11434');
    expect(at('[::1]:11500')).toBe('http://[::1]:11500');
  });
});

describe('localOllamaBase: anything off-host is ignored', () => {
  it('remote names and addresses fall back to the default', () => {
    for (const v of [
      'gpu-box',
      'gpu-box:11434',
      '192.168.1.5:11434',
      '10.0.0.1',
      '0.0.0.0',
      '0.0.0.0:11434',
      'http://ollama.example.com',
      'https://ollama.example.com:443',
      '[2001:db8::1]:11434',
      'localhost.evil.example',
      '127.0.0.1.evil.example',
      '127.0.0.256',
      '128.0.0.1',
    ]) {
      expect(at(v), v).toBe(DEFAULT);
    }
  });
  it('credentials, paths, queries and fragments are refused', () => {
    for (const v of [
      'http://user:pw@localhost:11434',
      'localhost:11434/api',
      'http://localhost:11434/v1',
      'localhost:11434?x=1',
      'localhost:11434#frag',
    ]) {
      expect(at(v), v).toBe(DEFAULT);
    }
  });
  it('bad ports fall back', () => {
    for (const v of ['localhost:0', 'localhost:65536', 'localhost:abc', 'localhost:-1', 'localhost:1.5', 'localhost:']) {
      expect(at(v), v).toBe(DEFAULT);
    }
  });
});
