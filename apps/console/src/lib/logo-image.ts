/** Largest logo the API keeps. */
export const LOGO_MAX_BYTES = 64 * 1024;
const SIDE = 256;

export type LogoUpload = { contentType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string };

/**
 * Shrinks a picked image to at most 256 px on its longer side and encodes it small enough for the API (WebP where
 * the browser can, else PNG; JPEG on white as a last try). Null when the file is not an image or stays too big.
 */
export async function shrinkLogo(file: File): Promise<LogoUpload | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const scale = Math.min(1, SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d');
  if (!g) return null;
  const tries: [LogoUpload['contentType'], number | undefined, boolean][] = [
    ['image/webp', 0.9, false],
    ['image/png', undefined, false],
    ['image/webp', 0.75, false],
    ['image/jpeg', 0.85, true],
    ['image/jpeg', 0.7, true],
  ];
  for (const [type, quality, white] of tries) {
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (white) {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, canvas.width, canvas.height);
    }
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, quality));
    // A browser that cannot write WebP hands back PNG; that try is then the same as the next one.
    if (!blob || blob.type !== type || blob.size > LOGO_MAX_BYTES) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { contentType: type, data: btoa(bin) };
  }
  return null;
}
