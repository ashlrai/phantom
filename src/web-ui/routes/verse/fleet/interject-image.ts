/** One optional screenshot rides with a "Tell the leaders" message: PNG or
 * JPEG, at most 5 MiB. The server re-checks the magic bytes itself — these
 * helpers only gate what the composer accepts and keep the chip honest. */

export const INTERJECT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

export interface InterjectImage {
  /** base64 payload without the data: prefix — the wire `image` field. */
  data: string;
  bytes: number;
}

/** null when the file can ride along; a plain reason when it cannot. */
export function interjectImageError(file: { type: string; size: number }): string | null {
  if (!IMAGE_TYPES.has(file.type)) return 'Only PNG or JPEG screenshots can be attached.';
  if (file.size > INTERJECT_IMAGE_MAX_BYTES) return 'Screenshots are limited to 5 MB.';
  return null;
}

export function readInterjectImage(file: Blob): Promise<InterjectImage> {
  return new Promise<InterjectImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read-failed'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma === -1) { reject(new Error('read-failed')); return; }
      resolve({ data: result.slice(comma + 1), bytes: file.size });
    };
    reader.readAsDataURL(file);
  });
}

export function interjectImageChip(image: InterjectImage): string {
  return `screenshot attached (${Math.max(1, Math.ceil(image.bytes / 1024))} KB)`;
}
