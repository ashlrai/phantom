/**
 * macOS helper bridge for the desktop operator.
 *
 * The Verse window path in desktop/src-tauri/src/computer.rs keeps
 * ScreenCaptureKit, the HUD and per-chat grants. This helper is the CLI
 * path: AXUIElement reads, CGWindow screenshots, Vision OCR, CGEvent input.
 * It is spawned only on darwin when a binary is present.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopSurface, DesktopWindow, RunningDesktopApp, SurfaceResult } from './operator.js';

const HELPER_TIMEOUT_MS = 20_000;

export function desktopOperatorCandidates(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const configured = env['PHANTOM_DESKTOP_OPERATOR'];
  if (typeof configured === 'string' && configured.length > 0) return [configured];
  const home = env['HOME'];
  return [
    ...(typeof home === 'string' && home.length > 0 ? [join(home, '.ashlr', 'bin', 'desktop-operator')] : []),
    join(cwd, 'tools', 'desktop-operator', 'desktop-operator'),
  ];
}

export function resolveDesktopOperatorBinary(
  env: NodeJS.ProcessEnv,
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  return desktopOperatorCandidates(env, cwd).find((path) => exists(path)) ?? null;
}

export function parseHelperPayload(stdout: string): SurfaceResult<Record<string, unknown>> {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, code: 'failed', error: 'desktop-operator helper returned an empty response' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, code: 'failed', error: 'desktop-operator helper returned non-JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'failed', error: 'desktop-operator helper returned a non-object' };
  }
  const record = parsed as Record<string, unknown>;
  if (record['ok'] === false) {
    const code = record['code'];
    const permission = record['permission'];
    if (code === 'permission_required' && (permission === 'accessibility' || permission === 'screen_recording')) {
      return { ok: false, code: 'permission_required', permission };
    }
    if (code === 'secure_field' || code === 'not_running' || code === 'denied' || code === 'forbidden_store') {
      const error = typeof record['error'] === 'string' ? record['error'] : String(code);
      return { ok: false, code, error };
    }
    return { ok: false, code: 'failed', error: typeof record['error'] === 'string' ? record['error'] : 'desktop-operator helper refused the request' };
  }
  if (record['ok'] !== true) return { ok: false, code: 'failed', error: 'desktop-operator helper omitted ok' };
  return { ok: true, value: record };
}

function helperError(error: unknown): SurfaceResult<never> {
  const message = error instanceof Error ? error.message : 'desktop-operator helper failed';
  return { ok: false, code: 'failed', error: message.slice(0, 200) };
}

export async function runHelper(binary: string, request: Record<string, unknown>): Promise<SurfaceResult<Record<string, unknown>>> {
  const payload = JSON.stringify(request);
  if (payload.length > 64_000) return { ok: false, code: 'failed', error: 'desktop operator request is too large' };
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('desktop-operator helper timed out'));
      }, HELPER_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= 2_000_000) chunks.push(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      child.stdin.end(payload);
    });
    return parseHelperPayload(stdout);
  } catch (error) {
    return helperError(error);
  }
}

function asApps(value: Record<string, unknown>): SurfaceResult<RunningDesktopApp[]> {
  if (!Array.isArray(value['apps'])) return { ok: false, code: 'failed', error: 'desktop-operator helper omitted apps' };
  const apps = [];
  for (const entry of value['apps']) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row['name'] !== 'string' || typeof row['pid'] !== 'number') continue;
    apps.push({
      name: row['name'],
      bundleId: typeof row['bundleId'] === 'string' ? row['bundleId'] : null,
      pid: row['pid'],
      executablePath: typeof row['executablePath'] === 'string' ? row['executablePath'] : null,
    });
  }
  return { ok: true, value: apps };
}

function asWindows(value: Record<string, unknown>): SurfaceResult<DesktopWindow[]> {
  if (!Array.isArray(value['windows'])) return { ok: false, code: 'failed', error: 'desktop-operator helper omitted windows' };
  const windows = [];
  for (const entry of value['windows']) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row['app'] !== 'string' || typeof row['title'] !== 'string' || typeof row['pid'] !== 'number') continue;
    windows.push({
      app: row['app'],
      bundleId: typeof row['bundleId'] === 'string' ? row['bundleId'] : null,
      title: row['title'],
      windowId: typeof row['windowId'] === 'number' ? row['windowId'] : 0,
      focused: row['focused'] === true,
      pid: row['pid'],
    });
  }
  return { ok: true, value: windows };
}

export function createDarwinSurface(binary: string): DesktopSurface {
  const call = (request: Record<string, unknown>) => runHelper(binary, request);
  return {
    async permissions() {
      const result = await call({ op: 'doctor' });
      if (!result.ok) return { accessibility: false, screenRecording: false, failed: result.error ?? 'desktop-operator helper failed' };
      return {
        accessibility: result.value['accessibility'] === true,
        screenRecording: result.value['screenRecording'] === true,
      };
    },
    async listApps() {
      const result = await call({ op: 'list-apps' });
      return result.ok ? asApps(result.value) : result;
    },
    async windows(app) {
      const result = await call({ op: 'windows', ...(app ? { app } : {}) });
      return result.ok ? asWindows(result.value) : result;
    },
    async focus(input) {
      const result = await call({ op: 'focus', ...input });
      return result.ok ? { ok: true, value: { focused: true } } : result;
    },
    async read(input) {
      const result = await call({ op: 'read', ...input });
      if (!result.ok) return result;
      const source = result.value['source'] === 'ocr' ? 'ocr' : 'ax';
      return {
        ok: true,
        value: {
          source,
          text: typeof result.value['text'] === 'string' ? result.value['text'] : '',
          truncated: result.value['truncated'] === true,
          nodes: typeof result.value['nodes'] === 'number' ? result.value['nodes'] : 0,
        },
      };
    },
    async scroll(input) {
      const result = await call({ op: 'scroll', ...input });
      return result.ok ? { ok: true, value: { scrolled: true } } : result;
    },
    async type(input) {
      const result = await call({ op: 'type', ...input });
      if (!result.ok) return result;
      return { ok: true, value: { typed: typeof result.value['typed'] === 'number' ? result.value['typed'] : input.text.length } };
    },
    async click(input) {
      const result = await call({ op: 'click', ...input });
      return result.ok ? { ok: true, value: { clicked: true } } : result;
    },
    async screenshot(input) {
      const result = await call({ op: 'screenshot', ...input });
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          mime: 'image/png' as const,
          base64: typeof result.value['base64'] === 'string' ? result.value['base64'] : '',
          width: typeof result.value['width'] === 'number' ? result.value['width'] : 0,
          height: typeof result.value['height'] === 'number' ? result.value['height'] : 0,
          ocrText: typeof result.value['ocrText'] === 'string' ? result.value['ocrText'] : '',
        },
      };
    },
  };
}
