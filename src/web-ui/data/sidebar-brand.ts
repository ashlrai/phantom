import { getMutationToken, getReadClientProof, renewReadSession } from './auth-store.js';

const path = '/api/verse/appearance/brand-image';
export const MAX_BRAND_FILE_BYTES = 512 * 1024;

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function readSidebarBrand(signal: AbortSignal): Promise<string | null> {
  const request = () => fetch(path, {
    credentials: 'same-origin',
    headers: { 'x-ashlr-read-client': getReadClientProof() },
    signal,
  });
  try {
    let response = await request();
    if (response.status === 401 && await renewReadSession()) response = await request();
    if (!response.ok) return null;
    const image = await response.blob();
    return ['image/svg+xml', 'image/png', 'image/webp'].includes(image.type) ? await dataUrl(image) : null;
  } catch {
    return null;
  }
}

export async function uploadSidebarBrand(file: File): Promise<void> {
  if (file.size > MAX_BRAND_FILE_BYTES) throw new Error('Brand images must be at most 512 KB.');
  const token = getMutationToken();
  if (!token) throw new Error('Unlock writes in Connection before uploading a brand image.');
  const encoded = await dataUrl(file);
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'text/plain', 'x-ashlr-token': token },
    body: encoded.slice(encoded.indexOf(',') + 1),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? 'Could not upload the brand image.');
  }
  const { applyUploadedAppearance } = await import('./appearance-sync.js');
  await applyUploadedAppearance(await response.json());
}
